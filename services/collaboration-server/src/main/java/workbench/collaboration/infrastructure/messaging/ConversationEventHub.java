package workbench.collaboration.infrastructure.messaging;

import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 模块：会话事件 SSE 实时分发集线器 (ConversationEventHub)
 *
 * <p>【功能定义】
 * 管理本机节点上打开的所有会话 Server-Sent Events (SSE) 长连接（SseEmitter）。
 * 针对活跃会话提供线程安全的事件推送、游标过滤、异常通道清理与心跳保活。
 *
 * <p>【并发同步与事件不变量 (Invariants)】
 * - 会话级并发锁（ReentrantLock）：每个 conversationId 分配一把独立可重入锁；
 * - 补历史与推实时的原子性：新连接进入时，在持锁状态下先完成历史事件拉取补齐，再将该 emitter 注册进订阅池；
 *   事件发布方亦必须在持该锁状态下向集线器提交事件。彻底杜绝历史事件与实时事件之间的交错漏发或重复推送。
 * - 游标单调递增过滤：仅当事件 sequence > 订阅者的已读游标 cursor 时才执行 send，并在成功后推进 cursor。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、ConversationSseController、MiddlewareConfig 心跳定时器。
 * - 下游依赖方：Spring WebMVC SseEmitter。
 */
public final class ConversationEventHub {

    private final ConcurrentHashMap<String, ReentrantLock> locks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<Subscriber>> subscribers = new ConcurrentHashMap<>();

    /**
     * 获取指定会话的专用并发锁。
     */
    public ReentrantLock lock(String conversationId) {
        return locks.computeIfAbsent(conversationId, ignored -> new ReentrantLock());
    }

    /**
     * 注册新的 SSE 订阅连接，并绑定生命周期回调（完成、超时、网络异常自动移除）。
     */
    public void add(String conversationId, SseEmitter emitter, long cursor) {
        subscribers.computeIfAbsent(conversationId, ignored -> new CopyOnWriteArrayList<>())
                .add(new Subscriber(emitter, cursor));
        emitter.onCompletion(() -> remove(conversationId, emitter));
        emitter.onTimeout(() -> remove(conversationId, emitter));
        emitter.onError(ignored -> remove(conversationId, emitter));
    }

    /**
     * 向指定会话的所有有效 SSE 长连接推送实时事件。
     * 调用方必须已经持有该会话的专属并发锁。
     */
    public void deliver(String conversationId, String eventJson, long sequence) {
        List<Subscriber> current = subscribers.get(conversationId);
        if (current == null) {
            return;
        }
        for (Subscriber subscriber : current) {
            if (sequence <= subscriber.cursor) {
                continue;
            }
            try {
                subscriber.emitter.send(SseEmitter.event()
                        .id(conversationId + ":" + sequence)
                        .name("conversation.event")
                        .data(eventJson));
                subscriber.cursor = sequence;
            } catch (IOException | IllegalStateException e) {
                remove(conversationId, subscriber.emitter);
            }
        }
    }

    /**
     * 全局广播轻量 ping 保活注释行，维持长连接不断开。
     */
    public void heartbeat() {
        for (var entry : subscribers.entrySet()) {
            for (Subscriber subscriber : entry.getValue()) {
                try {
                    subscriber.emitter.send(SseEmitter.event().comment("ping"));
                } catch (IOException | IllegalStateException e) {
                    remove(entry.getKey(), subscriber.emitter);
                }
            }
        }
    }

    private void remove(String conversationId, SseEmitter emitter) {
        CopyOnWriteArrayList<Subscriber> current = subscribers.get(conversationId);
        if (current != null) {
            current.removeIf(subscriber -> subscriber.emitter == emitter);
        }
    }

    private static final class Subscriber {
        private final SseEmitter emitter;
        private long cursor;

        private Subscriber(SseEmitter emitter, long cursor) {
            this.emitter = emitter;
            this.cursor = cursor;
        }
    }
}
