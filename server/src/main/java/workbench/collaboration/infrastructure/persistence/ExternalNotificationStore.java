package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.application.port.ExternalNotificationRepository;

import javax.sql.DataSource;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 模块：外部通知异步出站队列持久化存储 (ExternalNotificationStore)
 *
 * <p>【功能定义】
 * 基于 `wb_external_notification_delivery` 表提供同事务入队、对象终结消噪、
 * 条件更新并发抢占（pending → sending，防多实例重复投递）及重试/跳过/失败状态落库。
 */
@Repository
public class ExternalNotificationStore implements ExternalNotificationRepository {

    private static final Pattern CONTROL_CHARS = Pattern.compile("[\\p{Cntrl}]+");

    private static final RowMapper<DeliveryRecord> ROW_MAPPER = (row, index) -> new DeliveryRecord(
            row.getLong("id"),
            row.getString("delivery_id"),
            row.getString("user_id"),
            row.getString("workspace_id"),
            row.getString("project_id"),
            row.getString("event_type"),
            row.getString("object_id"),
            row.getString("actor_id"),
            row.getInt("urgency"),
            row.getString("title_snapshot"),
            row.getString("merge_key"),
            row.getInt("status"),
            row.getString("skip_reason"),
            row.getInt("attempt_count"),
            row.getInt("max_attempts"),
            Times.ms(row.getObject("available_at", LocalDateTime.class)),
            row.getString("last_error"),
            Times.ms(row.getObject("occurred_at", LocalDateTime.class))
    );

    private final JdbcTemplate jdbc;

    public ExternalNotificationStore(DataSource dataSource) {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    @Override
    public void enqueue(NewDelivery delivery) {
        LocalDateTime occurredAt = Times.ofMs(delivery.occurredAtMs());
        jdbc.update("""
                INSERT INTO wb_external_notification_delivery (
                  delivery_id, user_id, workspace_id, project_id, event_type, object_id, actor_id,
                  urgency, title_snapshot, merge_key, status, skip_reason, attempt_count, max_attempts,
                  available_at, last_error, occurred_at, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'',0,?,?,'',?,?,?)
                """,
                delivery.deliveryId(),
                delivery.userId(),
                delivery.workspaceId(),
                delivery.projectId() == null ? "" : delivery.projectId(),
                delivery.eventType(),
                delivery.objectId(),
                delivery.actorId(),
                delivery.urgency(),
                clamp(delivery.titleSnapshot(), 120),
                clamp(delivery.mergeKey(), 128),
                STATUS_PENDING,
                delivery.maxAttempts(),
                Times.ofMs(delivery.availableAtMs()),
                occurredAt,
                occurredAt,
                occurredAt
        );
    }

    @Override
    public int cancelPendingByObject(String objectId, String skipReason, long nowMs) {
        return jdbc.update("""
                UPDATE wb_external_notification_delivery
                SET status = ?, skip_reason = ?, updated_at = ?
                WHERE object_id = ? AND status = ?
                """, STATUS_SKIPPED, clamp(skipReason, 64), Times.ofMs(nowMs), objectId, STATUS_PENDING);
    }

    @Override
    public int cancelPendingByObjectAndUser(String objectId, String userId, String skipReason, long nowMs) {
        return jdbc.update("""
                UPDATE wb_external_notification_delivery
                SET status = ?, skip_reason = ?, updated_at = ?
                WHERE object_id = ? AND user_id = ? AND status = ?
                """, STATUS_SKIPPED, clamp(skipReason, 64), Times.ofMs(nowMs), objectId, userId, STATUS_PENDING);
    }

    @Override
    public int cancelPendingByWorkspaceAndUser(String workspaceId, String userId, String skipReason, long nowMs) {
        return jdbc.update("""
                UPDATE wb_external_notification_delivery
                SET status = ?, skip_reason = ?, updated_at = ?
                WHERE workspace_id = ? AND user_id = ? AND status = ?
                """, STATUS_SKIPPED, clamp(skipReason, 64), Times.ofMs(nowMs), workspaceId, userId, STATUS_PENDING);
    }

    @Override
    public List<DeliveryRecord> claimDueBatch(long nowMs, int limit) {
        LocalDateTime now = Times.ofMs(nowMs);
        List<DeliveryRecord> candidates = jdbc.query("""
                SELECT * FROM wb_external_notification_delivery
                WHERE status = ? AND available_at <= ?
                ORDER BY available_at ASC, id ASC
                LIMIT ?
                """, ROW_MAPPER, STATUS_PENDING, now, limit);
        return claimCandidates(candidates, now);
    }

    @Override
    public List<DeliveryRecord> claimPendingInMergeGroup(String userId, String mergeKey, long nowMs) {
        LocalDateTime now = Times.ofMs(nowMs);
        List<DeliveryRecord> candidates = jdbc.query("""
                SELECT * FROM wb_external_notification_delivery
                WHERE user_id = ? AND merge_key = ? AND status = ? AND attempt_count = 0
                ORDER BY occurred_at ASC, id ASC
                """, ROW_MAPPER, userId, mergeKey, STATUS_PENDING);
        return claimCandidates(candidates, now);
    }

    @Override
    public Optional<DeliveryRecord> findByDeliveryId(String deliveryId) {
        return jdbc.query("SELECT * FROM wb_external_notification_delivery WHERE delivery_id = ?",
                ROW_MAPPER, deliveryId).stream().findFirst();
    }

    @Override
    public void markSent(List<Long> rowIds, long nowMs) {
        if (rowIds == null || rowIds.isEmpty()) return;
        updateByIds("status = ?, skip_reason = '', last_error = '', updated_at = ?",
                List.of(STATUS_SENT, Times.ofMs(nowMs)), rowIds);
    }

    @Override
    public void markSkipped(List<Long> rowIds, String skipReason, long nowMs) {
        if (rowIds == null || rowIds.isEmpty()) return;
        updateByIds("status = ?, skip_reason = ?, updated_at = ?",
                List.of(STATUS_SKIPPED, clamp(skipReason, 64), Times.ofMs(nowMs)), rowIds);
    }

    @Override
    public void markDeferred(List<Long> rowIds, long nextAvailableAtMs, long nowMs) {
        if (rowIds == null || rowIds.isEmpty()) return;
        updateByIds("status = ?, available_at = ?, updated_at = ?",
                List.of(STATUS_PENDING, Times.ofMs(nextAvailableAtMs), Times.ofMs(nowMs)), rowIds);
    }

    @Override
    public void markRetry(List<Long> rowIds, int nextAttemptCount, long nextAvailableAtMs, String lastError, long nowMs) {
        if (rowIds == null || rowIds.isEmpty()) return;
        updateByIds("status = ?, attempt_count = ?, available_at = ?, last_error = ?, updated_at = ?",
                List.of(STATUS_PENDING, nextAttemptCount, Times.ofMs(nextAvailableAtMs), sanitizeError(lastError), Times.ofMs(nowMs)),
                rowIds);
    }

    @Override
    public void markFailed(List<Long> rowIds, int attemptCount, String lastError, long nowMs) {
        if (rowIds == null || rowIds.isEmpty()) return;
        updateByIds("status = ?, attempt_count = ?, last_error = ?, updated_at = ?",
                List.of(STATUS_FAILED, attemptCount, sanitizeError(lastError), Times.ofMs(nowMs)), rowIds);
    }

    private List<DeliveryRecord> claimCandidates(List<DeliveryRecord> candidates, LocalDateTime now) {
        List<DeliveryRecord> claimed = new ArrayList<>(candidates.size());
        for (DeliveryRecord candidate : candidates) {
            int updated = jdbc.update("""
                    UPDATE wb_external_notification_delivery
                    SET status = ?, updated_at = ?
                    WHERE id = ? AND status = ?
                    """, STATUS_SENDING, now, candidate.rowId(), STATUS_PENDING);
            if (updated == 1) {
                claimed.add(new DeliveryRecord(
                        candidate.rowId(), candidate.deliveryId(), candidate.userId(),
                        candidate.workspaceId(), candidate.projectId(), candidate.eventType(),
                        candidate.objectId(), candidate.actorId(), candidate.urgency(),
                        candidate.titleSnapshot(), candidate.mergeKey(), STATUS_SENDING,
                        candidate.skipReason(), candidate.attemptCount(), candidate.maxAttempts(),
                        candidate.availableAtMs(), candidate.lastError(), candidate.occurredAtMs()
                ));
            }
        }
        return claimed;
    }

    private void updateByIds(String setClause, List<Object> leadingArgs, List<Long> rowIds) {
        String placeholders = String.join(",", Collections.nCopies(rowIds.size(), "?"));
        List<Object> args = new ArrayList<>(leadingArgs.size() + rowIds.size());
        args.addAll(leadingArgs);
        args.addAll(rowIds);
        jdbc.update("UPDATE wb_external_notification_delivery SET " + setClause + " WHERE id IN (" + placeholders + ")",
                args.toArray());
    }

    private static String sanitizeError(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        return clamp(CONTROL_CHARS.matcher(raw).replaceAll(" ").strip(), 256);
    }

    private static String clamp(String value, int maxLen) {
        if (value == null) return "";
        return value.length() <= maxLen ? value : value.substring(0, maxLen);
    }
}
