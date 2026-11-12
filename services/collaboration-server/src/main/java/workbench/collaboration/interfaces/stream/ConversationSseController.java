package workbench.collaboration.interfaces.stream;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import workbench.collaboration.application.service.ConversationAppService;
import workbench.collaboration.application.service.IdentityAppService;
import workbench.collaboration.domain.conversation.EventWindowPort;
import workbench.collaboration.infrastructure.messaging.ConversationEventHub;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.rest.CurrentSession;

import java.io.IOException;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 模块：会话事件 SSE 实时流端点 (ConversationSseController)
 *
 * <p>【功能定义】
 * 提供 HTTP Server-Sent Events (SSE) 长连接通道（/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/events）。
 * 为桌面端与浏览器提供低延迟、事件驱动的会话事件增量流。
 *
 * <p>【断线重连与高可靠保序补齐 (Why)】
 * 1. 客户端支持通过 URL 参数 afterSequence 或 HTTP 标准 Last-Event-ID 请求头指定上次接收到的事件序号；
 * 2. 在获取该会话专属并发锁（ReentrantLock）后，优先从 Redis/内存热滑窗中读取未消费的增量事件直接推送给客户端；
 * 3. 补齐完成后将连接注册进 ConversationEventHub 实时广播池，随后释放并发锁。
 *    彻底避免在建立长连接瞬间由于并发新事件产生漏发或乱序，全程零数据库查询开销。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面会话视图。
 * - 下游依赖方：ConversationEventHub、EventWindowPort、ConversationAppService、IdentityAppService。
 */
@RestController
public class ConversationSseController {

    private final IdentityAppService identity;
    private final ConversationAppService conversations;
    private final EventWindowPort events;
    private final ConversationEventHub hub;

    public ConversationSseController(
            IdentityAppService identity,
            ConversationAppService conversations,
            EventWindowPort events,
            ConversationEventHub hub
    ) {
        this.identity = identity;
        this.conversations = conversations;
        this.events = events;
        this.hub = hub;
    }

    /**
     * 建立会话实时事件流式 SSE 通道。
     */
    @GetMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(
            @PathVariable String workspaceId,
            @PathVariable String conversationId,
            @RequestParam(required = false) String afterSequence,
            HttpServletRequest request
    ) throws IOException {
        identity.requireMember(workspaceId, CurrentSession.userId());
        conversations.requireConversation(workspaceId, conversationId);

        long cursor = cursor(conversationId, afterSequence, request.getHeader("Last-Event-ID"));
        // 创建无超时永不主动关闭的 SseEmitter
        SseEmitter emitter = new SseEmitter(0L);

        // 获取会话专属锁：原子完成“热滑窗拉取补历史 + 登记入实时推送池”
        ReentrantLock lock = hub.lock(conversationId);
        lock.lock();
        try {
            long sent = cursor;
            for (var event : events.range(conversationId, cursor, Long.MAX_VALUE, 200)) {
                emitter.send(SseEmitter.event()
                        .id(conversationId + ":" + event.sequence())
                        .name("conversation.event")
                        .data(event.eventJson()));
                sent = event.sequence();
            }
            hub.add(conversationId, emitter, sent);
        } finally {
            lock.unlock();
        }
        return emitter;
    }

    private static long cursor(String conversationId, String afterSequence, String lastEventId) {
        if (lastEventId != null && !lastEventId.isBlank()) {
            String prefix = conversationId + ":";
            if (!lastEventId.startsWith(prefix)) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            return Long.parseLong(lastEventId.substring(prefix.length()));
        }
        if (afterSequence == null || afterSequence.isBlank()) {
            return 0L;
        }
        return Long.parseLong(afterSequence);
    }
}
