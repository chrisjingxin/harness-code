package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.snapshot.ConversationSnapshot;
import workbench.collaboration.domain.snapshot.SnapshotRepository;

import javax.sql.DataSource;
import java.time.LocalDateTime;
import java.util.Optional;

/** 保存并读取整份快照。调用方先完成项目授权与正文限额校验。 */
@Repository
public class SnapshotRepositoryImpl implements SnapshotRepository {
    private final JdbcTemplate jdbc;

    public SnapshotRepositoryImpl(DataSource source) {
        this.jdbc = new JdbcTemplate(source);
    }

    @Override
    public void insert(ConversationSnapshot snapshot) {
        jdbc.update("""
                INSERT INTO wb_snapshot (
                    snapshot_id, project_id, source_conversation_id, source_owner_user_id, source_title,
                    source_synced_sequence, source_synced_at, from_sequence, to_sequence, message_count,
                    text, sha256, created_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                snapshot.snapshotId(), snapshot.projectId(), snapshot.sourceConversationId(),
                snapshot.sourceOwnerUserId(), snapshot.sourceTitle(), snapshot.sourceSyncedSequence(),
                Times.ofMs(snapshot.sourceSyncedAtMs()), snapshot.fromSequence(), snapshot.toSequence(),
                snapshot.messageCount(), snapshot.text(), snapshot.sha256(), snapshot.createdByUserId(),
                Times.ofMs(snapshot.createdAtMs()));
    }

    @Override
    public Optional<ConversationSnapshot> findInProject(String projectId, String snapshotId) {
        return jdbc.query("""
                SELECT snapshot_id, project_id, source_conversation_id, source_owner_user_id, source_title,
                       source_synced_sequence, source_synced_at, from_sequence, to_sequence, message_count,
                       text, sha256, created_by_user_id, created_at
                  FROM wb_snapshot
                 WHERE project_id = ? AND snapshot_id = ?
                """, (row, index) -> new ConversationSnapshot(
                        row.getString("snapshot_id"), row.getString("project_id"),
                        row.getString("source_conversation_id"), row.getString("source_owner_user_id"),
                        row.getString("source_title"), row.getLong("source_synced_sequence"),
                        Times.ms(row.getObject("source_synced_at", LocalDateTime.class)),
                        row.getLong("from_sequence"), row.getLong("to_sequence"), row.getInt("message_count"),
                        row.getString("text"), row.getString("sha256"), row.getString("created_by_user_id"),
                        Times.ms(row.getObject("created_at", LocalDateTime.class))),
                projectId, snapshotId).stream().findFirst();
    }
}
