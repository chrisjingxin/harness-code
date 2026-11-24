package workbench.collaboration.infrastructure.persistence;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest;

import javax.sql.DataSource;
import java.time.LocalDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * 模块：用户通知偏好持久化存储 (NotificationPreferenceStore)
 *
 * <p>【功能定义】
 * 基于 wb_user_notification_pref 表存取用户级通知降噪偏好（总开关、订阅事件、免打扰、合批窗口）。
 * 首次写入使用 expectedVersion=0 插入并设置 version=1；后续修改使用 version 条件更新防并发覆盖。
 */
@Repository
public class NotificationPreferenceStore implements NotificationPreferenceRepository {
    private static final int FLAG_ENABLED = 1;
    private static final int FLAG_DISABLED = 2;

    private final JdbcTemplate jdbc;

    public NotificationPreferenceStore(DataSource dataSource) {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    @Override
    public Optional<NotificationPreferences> findByUserId(String userId) {
        return jdbc.query("""
                        SELECT external_enabled, subscribed_events, dnd_enabled, dnd_start_minute,
                               dnd_end_minute, dnd_timezone, merge_window_sec, version
                        FROM wb_user_notification_pref
                        WHERE user_id = ?
                        """,
                (row, index) -> new NotificationPreferences(
                        row.getInt("external_enabled") == FLAG_ENABLED,
                        parseEvents(row.getString("subscribed_events")),
                        row.getInt("dnd_enabled") == FLAG_ENABLED,
                        row.getInt("dnd_start_minute"),
                        row.getInt("dnd_end_minute"),
                        row.getString("dnd_timezone"),
                        row.getInt("merge_window_sec"),
                        row.getLong("version")
                ),
                userId
        ).stream().findFirst();
    }

    @Override
    public boolean upsertIfVersion(String userId, NotificationPreferencesUpdateRequest request, long nowMs) {
        int externalFlag = request.externalEnabled() ? FLAG_ENABLED : FLAG_DISABLED;
        int dndFlag = request.dndEnabled() ? FLAG_ENABLED : FLAG_DISABLED;
        String events = String.join(",", request.subscribedEvents());
        LocalDateTime now = Times.ofMs(nowMs);
        if (request.expectedVersion() == 0) {
            try {
                return jdbc.update("""
                                INSERT INTO wb_user_notification_pref (
                                  user_id, external_enabled, subscribed_events, dnd_enabled,
                                  dnd_start_minute, dnd_end_minute, dnd_timezone, merge_window_sec,
                                  version, created_at, updated_at
                                ) VALUES (?,?,?,?,?,?,?,?,1,?,?)
                                """,
                        userId, externalFlag, events, dndFlag,
                        request.dndStartMinute(), request.dndEndMinute(), request.dndTimezone(),
                        request.mergeWindowSec(), now, now) == 1;
            } catch (DuplicateKeyException conflict) {
                return false;
            }
        }
        return jdbc.update("""
                        UPDATE wb_user_notification_pref
                        SET external_enabled = ?, subscribed_events = ?, dnd_enabled = ?,
                            dnd_start_minute = ?, dnd_end_minute = ?, dnd_timezone = ?,
                            merge_window_sec = ?, version = version + 1, updated_at = ?
                        WHERE user_id = ? AND version = ?
                        """,
                externalFlag, events, dndFlag,
                request.dndStartMinute(), request.dndEndMinute(), request.dndTimezone(),
                request.mergeWindowSec(), now, userId, request.expectedVersion()) == 1;
    }

    private static List<String> parseEvents(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        return Arrays.stream(raw.split(","))
                .map(String::trim)
                .filter(item -> !item.isEmpty())
                .toList();
    }
}
