package workbench.collaboration.application.service;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.KnowledgeStore;
import workbench.collaboration.infrastructure.search.ElasticsearchMessageStoreAdapter;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static workbench.collaboration.interfaces.dto.KnowledgeDtos.*;

/**
 * 团队知识的读写与固定版本入口。先校验团队成员，再使用数据库版本；
 * 集群索引只返回候选标识，正文与当前资格从数据库读取。
 */
@Service
public class KnowledgeAppService {
    private final ProjectAccessPolicy policy;
    private final KnowledgeStore store;
    private final NotificationPort notifications;
    private final ElasticsearchMessageStoreAdapter search;
    private final WorkbenchProperties properties;
    private final Contracts contracts;

    public KnowledgeAppService(ProjectAccessPolicy policy, KnowledgeStore store, NotificationPort notifications,
                               ElasticsearchMessageStoreAdapter search, WorkbenchProperties properties,
                               Contracts contracts) {
        this.policy = policy;
        this.store = store;
        this.notifications = notifications;
        this.search = search;
        this.properties = properties;
        this.contracts = contracts;
    }

    @Transactional
    public String create(String actor, String workspace, String raw) {
        policy.requireWorkspaceMember(workspace, actor);
        var input = contracts.decode("KnowledgeCreateRequest", raw, KnowledgeCreateRequest.class);
        String id = UUID.randomUUID().toString();
        var version = version(actor, 1, input.category(), input.title(), input.text());
        var item = item(id, input.termKey(), version);
        try {
            store.insert(workspace, item);
        } catch (DuplicateKeyException duplicate) {
            throw new ApiProblem(409, "KNOWLEDGE_TERM_CONFLICT");
        }
        store.append(id, version, input.text());
        return changed(actor, workspace, item);
    }

    @Transactional
    public String edit(String actor, String workspace, String id, String raw) {
        policy.requireWorkspaceMember(workspace, actor);
        var input = contracts.decode("KnowledgeUpdateRequest", raw, KnowledgeUpdateRequest.class);
        var before = find(workspace, id);
        var version = version(actor, before.version() + 1, input.category(), input.title(), input.text());
        var after = item(id, before.termKey(), version);
        update(workspace, before, after, input.expectedVersion());
        store.append(id, version, input.text());
        return changed(actor, workspace, after);
    }

    @Transactional
    public String archive(String actor, String workspace, String id, long expectedVersion) {
        policy.requireWorkspaceMember(workspace, actor);
        var before = find(workspace, id);
        var after = new KnowledgeSummary(id, before.termKey(), before.category(), before.title(),
                before.currentVersionId(), before.version() + 1, true, System.currentTimeMillis());
        update(workspace, before, after, expectedVersion);
        return changed(actor, workspace, after);
    }

    @Transactional(readOnly = true)
    public String read(String actor, String workspace, String id) {
        policy.requireWorkspaceMember(workspace, actor);
        return detail(find(workspace, id));
    }

    @Transactional(readOnly = true)
    public String readVersion(String actor, String workspace, String id, String versionId) {
        policy.requireWorkspaceMember(workspace, actor);
        return contracts.encode("KnowledgeVersion", readVersion(find(workspace, id), versionId));
    }

    @Transactional(readOnly = true)
    public String versions(String actor, String workspace, String id, String afterId, int limit) {
        policy.requireWorkspaceMember(workspace, actor);
        find(workspace, id);
        var rows = store.versions(id, afterId, limit + 1);
        var page = rows.subList(0, Math.min(rows.size(), limit));
        return contracts.encode("KnowledgeVersionListResponse",
                new KnowledgeVersionListResponse(page, rows.size() > limit ? page.getLast().versionId() : null));
    }

    @Transactional(readOnly = true)
    public String list(String actor, String workspace, String category, String query, String afterId, int limit) {
        policy.requireWorkspaceMember(workspace, actor);
        if (properties.cluster() && query != null) {
            var hits = search.searchKnowledge(workspace, category, query, afterId, limit + 1);
            var page = hits.subList(0, Math.min(hits.size(), limit));
            List<KnowledgeSummary> items = page.stream().flatMap(hit -> store.find(workspace, hit.id()).stream()
                    .filter(item -> !item.archived() && item.version() == hit.version()
                            && (category == null || category.equals(item.category())))).toList();
            return contracts.encode("KnowledgeListResponse",
                    new KnowledgeListResponse(items, hits.size() > limit ? page.getLast().id() : null));
        }
        var rows = store.list(workspace, category, query, afterId, limit + 1);
        var page = rows.subList(0, Math.min(rows.size(), limit));
        return contracts.encode("KnowledgeListResponse",
                new KnowledgeListResponse(page, rows.size() > limit ? page.getLast().knowledgeId() : null));
    }

    private String changed(String actor, String workspace, KnowledgeSummary after) {
        notifications.publish("knowledge.updated", after.knowledgeId(), Map.of("workspaceId", workspace, "actorId", actor));
        return detail(after);
    }

    private String detail(KnowledgeSummary item) {
        return contracts.encode("KnowledgeDetail", new KnowledgeDetail(item, readVersion(item, item.currentVersionId())));
    }

    private KnowledgeSummary find(String workspace, String id) {
        return store.find(workspace, id).orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    private KnowledgeVersion readVersion(KnowledgeSummary item, String versionId) {
        return store.version(item, versionId).orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    private void update(String workspace, KnowledgeSummary before, KnowledgeSummary after, long expectedVersion) {
        if (before.archived()) throw new ApiProblem(409, "KNOWLEDGE_ARCHIVED");
        if (before.version() != expectedVersion || !store.update(workspace, after, expectedVersion)) {
            throw new ApiProblem(409, "VERSION_CONFLICT");
        }
    }

    private static KnowledgeVersionSummary version(String actor, long number, String category, String title, String text) {
        if (category.isBlank() || title.isBlank() || text.isBlank()) throw new ApiProblem(400, "INVALID_REQUEST");
        return new KnowledgeVersionSummary(UUID.randomUUID().toString(), number, category.strip(), title.strip(),
                actor, System.currentTimeMillis());
    }

    private static KnowledgeSummary item(String id, String termKey, KnowledgeVersionSummary version) {
        return new KnowledgeSummary(id, termKey, version.category(), version.title(), version.versionId(),
                version.version(), false, version.createdAtMs());
    }
}
