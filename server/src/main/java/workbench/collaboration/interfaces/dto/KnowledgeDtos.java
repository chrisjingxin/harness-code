package workbench.collaboration.interfaces.dto;

import java.util.List;

/** 团队知识的固定版本、候选提议与复核 HTTP 形状；同源定义见 collaboration.schema.json。 */
public final class KnowledgeDtos {
    private KnowledgeDtos() {}

    /** KnowledgeRef 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeRef(String knowledgeId, String versionId) {}

    /** KnowledgeCreateRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeCreateRequest(String termKey, String category, String title, String text, String level, KnowledgeScope scope, String contentType, String requestId) {}

    /** KnowledgeUpdateRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeUpdateRequest(String category, String title, String text, long expectedVersion, String level, KnowledgeScope scope, String contentType, String requestId) {}

    /** KnowledgeSummary 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeSummary(String knowledgeId, String termKey, String category, String title, String currentVersionId, long version, boolean archived, long updatedAtMs, String level, KnowledgeScope scope, String contentType, KnowledgeHealth health) {}

    /** KnowledgeVersionSummary 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeVersionSummary(String versionId, long version, String category, String title, String authorId, long createdAtMs, String level, KnowledgeScope scope, String contentType, List<String> contributors, String proposalId, String reviewerId, Long reviewedAtMs) {}

    /** KnowledgeVersion 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeVersion(String knowledgeId, String termKey, boolean archived, KnowledgeVersionSummary version, String text) {}

    /** KnowledgeDetail 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeDetail(KnowledgeSummary item, KnowledgeVersion current) {}

    /** KnowledgeListResponse 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeListResponse(List<KnowledgeSummary> items, String nextAfterId) {}

    /** KnowledgeVersionListResponse 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeVersionListResponse(List<KnowledgeVersionSummary> versions, String nextAfterId) {}

    /** KnowledgeScope 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeScope(String kind, List<String> repositoryIds) {}

    /** KnowledgeHealth 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeHealth(long readCount, long usefulCount, long expiredCount, boolean needsReview, Long lastReviewedAtMs, long feedbackWatermark) {}

    /** KnowledgeCandidate 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeCandidate(String termKey, String category, String title, String text, String level, KnowledgeScope scope, String contentType) {}

    /** KnowledgeSource 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeSource(String kind, String referenceId, String projectId, Long revision) {}

    /** KnowledgeProposalContent 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalContent(String intent, String targetKnowledgeId, String baseVersionId, Long baseItemVersion, KnowledgeCandidate candidate, List<KnowledgeRef> relatedReferences, String sourceSummary, List<KnowledgeSource> sourceRefs, String generationKind) {}

    /** KnowledgeProposalCreateRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalCreateRequest(KnowledgeProposalContent content, boolean submit, String requestId) {}

    /** KnowledgeProposalUpdateRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalUpdateRequest(KnowledgeProposalContent content, long expectedRevision, String requestId) {}

    /** KnowledgeProposalActionRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalActionRequest(long expectedRevision, String requestId, boolean confirmShare) {}

    /** KnowledgeProposalReviewRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalReviewRequest(String decision, long expectedRevision, String requestId, String baseVersionId, Long expectedItemVersion, KnowledgeCandidate finalCandidate, String note) {}

    /** KnowledgeProposal 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposal(String proposalId, String workspaceId, String proposerId, KnowledgeProposalContent content, long revision, String status, long createdAtMs, long updatedAtMs, Long submittedAtMs, String lastReason, String publishedKnowledgeId, String publishedVersionId, String reviewerId, String outcome, boolean proposerActive) {}

    /** KnowledgeProposalSummary 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalSummary(String proposalId, String proposerId, String title, String level, String status, long revision, long updatedAtMs, boolean proposerActive) {}

    /** KnowledgeProposalListResponse 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalListResponse(List<KnowledgeProposalSummary> items, String nextAfterId) {}

    /** KnowledgeProposalEvent 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalEvent(String eventId, String kind, String actorId, String note, KnowledgeProposalContent content, long occurredAtMs) {}

    /** KnowledgeProposalDetail 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeProposalDetail(KnowledgeProposal proposal, List<KnowledgeProposalEvent> events, String nextAfterId) {}

    /** KnowledgeReadRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeReadRequest(String readId) {}

    /** KnowledgeUsageResponse 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeUsageResponse(long versionReadCount, long totalReadCount) {}

    /** KnowledgeFeedbackRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeFeedbackRequest(String value, String note, String requestId) {}

    /** KnowledgeFeedbackResponse 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeFeedbackResponse(String value, String note, long usefulCount, long expiredCount, long versionReadCount) {}

    /** KnowledgeReviewRequest 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeReviewRequest(long expectedItemVersion, String currentVersionId, long feedbackWatermark, String action, String note, String requestId) {}

    /** KnowledgeReviewEvent 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeReviewEvent(String eventId, String actorId, String kind, String versionId, String note, String value, long occurredAtMs) {}

    /** KnowledgeReviewDetail 的受校验业务载荷；身份和权限由服务端另行核对。 */
    public record KnowledgeReviewDetail(KnowledgeSummary item, List<KnowledgeReviewEvent> events, String nextAfterId) {}
}
