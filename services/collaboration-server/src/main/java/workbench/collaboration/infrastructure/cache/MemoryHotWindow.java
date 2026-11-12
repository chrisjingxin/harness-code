package workbench.collaboration.infrastructure.cache;

import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;

import java.util.Comparator;
import java.util.List;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentSkipListMap;

/**
 * 模块：进程内消息热滑窗实现 (MemoryHotWindow)
 *
 * <p>【功能定义】
 * 单机内存模式下实现 MessageStorePort（定稿消息存储）。
 * 采用并发跳表（ConcurrentSkipListMap）以会话连续序号 sequence 作为键，实现天然按时序自排序：
 * - 消息热滑窗：最多保留最近 100 条定稿消息；
 * - 超过容量上限时自动淘汰最小序号元素（pollFirstEntry），确保内存不泄漏。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig (standalone 模式)、ConversationSyncAppService。
 * - 下游依赖方：CacheKeys。
 */
public final class MemoryHotWindow implements MessageStorePort {

    private final ConcurrentHashMap<String, NavigableMap<Long, Message>> messages = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Message> byId = new ConcurrentHashMap<>();

    @Override
    public void save(Message message) {
        NavigableMap<Long, Message> window = messages.computeIfAbsent(message.conversationId(), ignored -> new ConcurrentSkipListMap<>());
        synchronized (window) {
            window.put(message.sequence(), message);
            trim(window, CacheKeys.MESSAGE_LIMIT);
        }
        byId.put(message.workspaceId() + ":" + message.messageId(), message);
    }

    @Override
    public Optional<Message> find(String workspaceId, String messageId) {
        return Optional.ofNullable(byId.get(workspaceId + ":" + messageId));
    }

    @Override
    public List<Message> recent(String conversationId, int limit) {
        NavigableMap<Long, Message> window = messages.get(conversationId);
        if (window == null) {
            return List.of();
        }
        synchronized (window) {
            return window.descendingMap().values().stream().limit(Math.max(0, limit)).toList();
        }
    }

    private static <T> void trim(NavigableMap<Long, T> window, int limit) {
        while (window.size() > limit) {
            window.pollFirstEntry();
        }
    }

    public int messageCount(String conversationId) {
        NavigableMap<Long, Message> window = messages.get(conversationId);
        return window == null ? 0 : window.size();
    }

    public Optional<Long> oldestMessageSequence(String conversationId) {
        NavigableMap<Long, Message> window = messages.get(conversationId);
        if (window == null || window.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(window.firstKey());
    }

    /**
     * 测试辅助：验证滑窗是严格按序号大小而非插入物理时序淘汰。
     */
    public List<Long> messageSequences(String conversationId) {
        NavigableMap<Long, Message> window = messages.get(conversationId);
        if (window == null) {
            return List.of();
        }
        return window.keySet().stream().sorted(Comparator.naturalOrder()).toList();
    }
}
