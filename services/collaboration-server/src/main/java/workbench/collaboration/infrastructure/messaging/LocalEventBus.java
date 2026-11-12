package workbench.collaboration.infrastructure.messaging;

import workbench.collaboration.application.port.RealtimeBroadcastPort;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiConsumer;

/**
 * 模块：进程内本地事件发布订阅总线 (LocalEventBus)
 *
 * <p>【功能定义】
 * 提供单机环境下基于内存线程安全列表（CopyOnWriteArrayList）实现的实时广播总线。
 * 当处在 standalone 模式时直接作为 RealtimeBroadcastPort 的主要实现；
 * 当处在 cluster 模式时作为 KafkaEventBus 在当前 JVM 节点上的本地分发器。
 * 彻底消除数据库定时轮询，实现纯事件驱动推送。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、KafkaEventBus。
 * - 下游依赖方：ConversationEventHub、DaemonWebSocketHandler、ElasticsearchMessageStoreAdapter。
 */
public final class LocalEventBus implements RealtimeBroadcastPort {

    private final List<BiConsumer<String, String>> conversation = new CopyOnWriteArrayList<>();
    private final List<BiConsumer<String, String>> daemon = new CopyOnWriteArrayList<>();
    private final List<BiConsumer<String, String>> search = new CopyOnWriteArrayList<>();

    public void onConversation(BiConsumer<String, String> listener) {
        conversation.add(listener);
    }

    public void onDaemon(BiConsumer<String, String> listener) {
        daemon.add(listener);
    }

    public void onSearch(BiConsumer<String, String> listener) {
        search.add(listener);
    }

    @Override
    public void publishConversationEvent(String conversationId, String eventJson) {
        deliver(conversation, conversationId, eventJson);
    }

    @Override
    public void publishDaemonCommand(String deviceId, String commandJson) {
        deliver(daemon, deviceId, commandJson);
    }

    @Override
    public void publishSearchIndex(String workspaceId, String documentJson) {
        deliver(search, workspaceId, documentJson);
    }

    private static void deliver(List<BiConsumer<String, String>> listeners, String key, String json) {
        for (BiConsumer<String, String> listener : listeners) {
            listener.accept(key, json);
        }
    }
}
