package workbench.collaboration.interfaces.dto;

import java.util.List;

/** 团队知识条目与固定版本的 HTTP 契约。 */
public final class KnowledgeDtos {
    private KnowledgeDtos() {}

    public record KnowledgeCreateRequest(String termKey, String category, String title, String text) {}
    public record KnowledgeUpdateRequest(String category, String title, String text, long expectedVersion) {}
    public record KnowledgeSummary(String knowledgeId, String termKey, String category, String title,
                                   String currentVersionId, long version, boolean archived, long updatedAtMs) {}
    public record KnowledgeVersionSummary(String versionId, long version, String category, String title,
                                          String authorId, long createdAtMs) {}
    public record KnowledgeVersion(String knowledgeId, String termKey, boolean archived,
                                   KnowledgeVersionSummary version, String text) {}
    public record KnowledgeDetail(KnowledgeSummary item, KnowledgeVersion current) {}
    public record KnowledgeListResponse(List<KnowledgeSummary> items, String nextAfterId) {}
    public record KnowledgeVersionListResponse(List<KnowledgeVersionSummary> versions, String nextAfterId) {}
}
