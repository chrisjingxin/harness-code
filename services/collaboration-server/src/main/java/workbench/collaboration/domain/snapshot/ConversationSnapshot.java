package workbench.collaboration.domain.snapshot;

/**
 * 项目成员固定的一份会话材料。来源、范围和正文在创建时一并保存，
 * 之后按快照 ID 读取，无需再次访问源会话或消息存储。
 * 简报使用 0 作为起止序号的存储值，接口对外返回 null。
 */
public record ConversationSnapshot(
        String snapshotId,
        String projectId,
        String sourceConversationId,
        String sourceOwnerUserId,
        String sourceTitle,
        long sourceSyncedSequence,
        long sourceSyncedAtMs,
        long fromSequence,
        long toSequence,
        int messageCount,
        String text,
        String sha256,
        String createdByUserId,
        long createdAtMs
) {}
