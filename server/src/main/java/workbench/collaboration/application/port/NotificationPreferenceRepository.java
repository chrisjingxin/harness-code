package workbench.collaboration.application.port;

import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest;

import java.util.Optional;

/**
 * 模块：用户通知偏好仓储端口 (NotificationPreferenceRepository)
 *
 * <p>【功能定义】
 * 读写用户跨团队与外部 IM 轻通知降噪偏好配置（开关、订阅事件、免打扰时段、合批窗口），
 * 并提供基于 expectedVersion 的乐观并发写入。
 */
public interface NotificationPreferenceRepository {

    /** 按用户标识读取持久化偏好；尚未配置时返回 empty。 */
    Optional<NotificationPreferences> findByUserId(String userId);

    /**
     * 原子写入或更新用户偏好。
     * expectedVersion 为 0 时执行首次插入（已存在返回 false）；大于 0 时执行版本匹配更新。
     */
    boolean upsertIfVersion(String userId, NotificationPreferencesUpdateRequest request, long nowMs);
}
