package workbench.collaboration.interfaces.rest;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.async.WebAsyncUtils;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import workbench.collaboration.application.service.NotificationAppService;
import workbench.collaboration.infrastructure.messaging.NotificationSignal;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.PageInput;

import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 用户通知的分页与 SSE 入口。按游标读一批 → 逐条发送 → 等提交信号或定时补读。
 * 流有固定寿命和数量上限，网络等待期间不持有数据库事务。
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/notifications")
public class NotificationController {
    private static final Logger LOGGER = LoggerFactory.getLogger(NotificationController.class);
    private static final String AUTHORIZED_STREAM = NotificationController.class.getName() + ".authorizedStream";
    private static final long STREAM_MS = 60_000;
    private static final long HEARTBEAT_MS = 15_000;

    private final NotificationAppService notifications;
    private final NotificationSignal signal;
    private final Semaphore streams = new Semaphore(128);
    private final java.util.concurrent.ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    public NotificationController(NotificationAppService notifications, NotificationSignal signal) {
        this.notifications = notifications;
        this.signal = signal;
    }

    @GetMapping
    public ResponseEntity<String> list(@PathVariable String workspaceId, @RequestParam(required = false) String afterId,
                                       @RequestParam(required = false) String limit) {
        return ApiResponses.json(200, notifications.encodePage(notifications.page(
                workspaceId, CurrentSession.userId(), PageInput.number(afterId, 0), PageInput.limit(limit))));
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> stream(@PathVariable String workspaceId,
                                             @RequestParam(required = false) String afterId,
                                             @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId,
                                             HttpServletRequest request) {
        String user = CurrentSession.userId();
        long cursor = PageInput.number(lastEventId != null ? lastEventId : afterId, 0);
        notifications.requireMember(workspaceId, user);
        HttpSession session = request.getSession(false);
        if (!signedIn(session, user)) throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
        if (!streams.tryAcquire()) throw new ApiProblem(503, "SERVICE_UNAVAILABLE");

        SseEmitter emitter = new SseEmitter(STREAM_MS);
        AtomicBoolean open = new AtomicBoolean(true);
        emitter.onCompletion(() -> open.set(false));
        emitter.onError(error -> open.set(false));
        emitter.onTimeout(() -> open.set(false));
        try {
            workers.execute(() -> send(workspaceId, user, cursor, session, emitter, open));
        } catch (java.util.concurrent.RejectedExecutionException stopping) {
            streams.release();
            throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
        }
        request.setAttribute(AUTHORIZED_STREAM, request.getRequestURI());
        return ResponseEntity.ok().header("X-Accel-Buffering", "no").body(emitter);
    }

    /** Spring 已有异步结果时仅收尾。注销已清除登录态，不能再用旧 Cookie 给收尾请求鉴权。 */
    public static boolean isStreamCompletion(HttpServletRequest request) {
        return request.getDispatcherType() == DispatcherType.ASYNC
                && request.getRequestURI().equals(request.getAttribute(AUTHORIZED_STREAM))
                && WebAsyncUtils.getAsyncManager(request).hasConcurrentResult();
    }

    private void send(String workspace, String user, long cursor, HttpSession session, SseEmitter emitter,
                      AtomicBoolean open) {
        long end = System.currentTimeMillis() + STREAM_MS;
        long nextHeartbeat = 0;
        boolean writeFailed = false;
        try {
            while (open.get() && signedIn(session, user) && System.currentTimeMillis() < end) {
                long generation = signal.generation();
                var page = notifications.page(workspace, user, cursor, 50);
                long now = System.currentTimeMillis();
                if (now >= nextHeartbeat) {
                    emitter.send(SseEmitter.event().comment("heartbeat"));
                    nextHeartbeat = now + HEARTBEAT_MS;
                }
                for (var event : page.events()) {
                    if (!open.get() || !signedIn(session, user)) return;
                    emitter.send(SseEmitter.event().id(Long.toString(event.id())).name(event.type())
                            .data(notifications.encodeEvent(event)));
                    cursor = event.id();
                }
                if (!page.hasMore()) signal.await(generation);
            }
        } catch (IOException disconnected) {
            // 写入失败后由 Servlet 容器通知 Spring 收尾，避免应用重复完成同一次响应。
            writeFailed = true;
        } catch (IllegalStateException | ApiProblem closed) {
            // 连接已断或权限变化。客户端重连时会再次经过认证并传回已处理游标。
        } catch (InterruptedException stopping) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException failure) {
            LOGGER.warn("用户通知暂无法读取，连接关闭后可按游标重试", failure);
        } finally {
            try {
                if (!writeFailed) emitter.complete();
            } finally {
                streams.release();
            }
        }
    }

    private static boolean signedIn(HttpSession session, String user) {
        try {
            return session != null && session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY)
                    instanceof SecurityContext context && context.getAuthentication() != null
                    && context.getAuthentication().isAuthenticated() && user.equals(context.getAuthentication().getName());
        } catch (IllegalStateException expired) {
            return false;
        }
    }

    @PreDestroy
    void close() {
        workers.shutdownNow();
    }
}
