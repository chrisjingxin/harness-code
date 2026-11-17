package workbench.collaboration.interfaces.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import workbench.collaboration.domain.snapshot.ConversationSnapshot;

/** 创建和读取共用的快照契约。请求范围由同名 JSON Schema 校验。 */
public final class SnapshotDtos {
    private SnapshotDtos() {}

    /** 省略范围时使用最新 20 条已同步消息。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SnapshotCreateRequest(String sourceConversationId, RequestedRange range) {}

    /** 每个类型只接受其对应的序号或条数字段。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RequestedRange(String type, Integer count, Long fromSequence, Long toSequence) {}

    /** 创建预览和后续按 ID 读取返回同一份材料。简报的起止序号为 null。 */
    public record SnapshotResponse(
            String snapshotId, String projectId, String sourceConversationId, String sourceOwnerUserId,
            String sourceTitle, long sourceSyncedSequence, long sourceSyncedAtMs,
            Long fromSequence, Long toSequence, int messageCount, String text, String sha256,
            String createdByUserId, long createdAtMs
    ) {
        public static SnapshotResponse from(ConversationSnapshot snapshot) {
            boolean hasMessages = snapshot.messageCount() > 0;
            return new SnapshotResponse(
                    snapshot.snapshotId(), snapshot.projectId(), snapshot.sourceConversationId(),
                    snapshot.sourceOwnerUserId(), snapshot.sourceTitle(), snapshot.sourceSyncedSequence(),
                    snapshot.sourceSyncedAtMs(), hasMessages ? snapshot.fromSequence() : null,
                    hasMessages ? snapshot.toSequence() : null, snapshot.messageCount(),
                    snapshot.text(), snapshot.sha256(), snapshot.createdByUserId(), snapshot.createdAtMs());
        }
    }
}
