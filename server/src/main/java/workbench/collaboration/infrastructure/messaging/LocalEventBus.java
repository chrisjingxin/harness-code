package workbench.collaboration.infrastructure.messaging;

import workbench.collaboration.application.port.SearchIndexBus;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiConsumer;

/**
 * 模块：进程内本地事件发布订阅总线 (LocalEventBus)
 *
 * <p>【功能定义】
 * 提供单机环境下基于内存线程安全列表（CopyOnWriteArrayList）实现的检索索引分发。
 * 当处在 standalone 模式时直接作为 SearchIndexBus 的主要实现；
 * 当处在 cluster 模式时作为 KafkaEventBus 在当前 JVM 节点上的本地分发器。
 * 旧的会话事件与设备指令分发通道已随远程派发链路拆除（HC-211）。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService、KafkaEventBus。
 * - 下游依赖方：ElasticsearchMessageStoreAdapter。
 */
public final class LocalEventBus implements SearchIndexBus {

    private final List<BiConsumer<String, String>> search = new CopyOnWriteArrayList<>();

    public void onSearch(BiConsumer<String, String> listener) {
        search.add(listener);
    }

    @Override
    public void publishSearchIndex(String workspaceId, String documentJson) {
        for (BiConsumer<String, String> listener : search) {
            listener.accept(workspaceId, documentJson);
        }
    }
}
