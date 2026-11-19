package workbench.collaboration.infrastructure.search;

import org.springframework.context.annotation.Conditional;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import workbench.collaboration.infrastructure.config.MiddlewareConfig;
import workbench.collaboration.infrastructure.persistence.KnowledgeStore;

import java.util.Map;

/**
 * 将已提交知识版本投影到现有 ES 配置的知识索引。
 * 先读一批待投影条目 → 在事务外写 ES → 标记成功版本。任何未标记版本都可在下轮重试。
 */
@Component
@Conditional(MiddlewareConfig.ClusterStartCondition.class)
public class KnowledgeIndexProjection {
    private static final int BATCH_SIZE = 16;
    private final KnowledgeStore store;
    private final ElasticsearchMessageStoreAdapter search;
    private long cursor;

    public KnowledgeIndexProjection(KnowledgeStore store, ElasticsearchMessageStoreAdapter search) {
        this.store = store;
        this.search = search;
    }

    @Scheduled(fixedDelay = 2000, initialDelay = 2000)
    public void project() {
        var pending = store.pendingIndex(cursor, BATCH_SIZE);
        for (var item : pending) {
            var document = Map.of("workspaceId", item.workspaceId(), "knowledgeId", item.knowledgeId(),
                    "version", item.version(), "archived", item.archived(), "termKey", item.termKey(),
                    "category", item.category(), "title", item.title(), "text", item.text());
            if (search.indexKnowledge(item.workspaceId(), item.knowledgeId(), item.version(), document)) {
                store.markIndexed(item);
            }
        }
        // 单条索引数据长期失败时，也让后面的条目继续投影。下一轮扫回起点再试失败项。
        cursor = pending.size() < BATCH_SIZE ? 0 : pending.getLast().rowId();
    }
}
