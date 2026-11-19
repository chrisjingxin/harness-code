package workbench.collaboration.domain.snapshot;

import java.util.Optional;

/** 快照只允许插入，读取始终限定在已授权的项目内。 */
public interface SnapshotRepository {
    void insert(ConversationSnapshot snapshot);
    Optional<ConversationSnapshot> findInProject(String projectId, String snapshotId);
}
