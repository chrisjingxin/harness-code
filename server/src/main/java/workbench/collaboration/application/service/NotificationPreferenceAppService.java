package workbench.collaboration.application.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.ZoneId;
import java.util.List;

/**
 * 模块：用户通知偏好应用服务 (NotificationPreferenceAppService)
 *
 * <p>【功能定义】
 * 提供跨团队外部通知开关、事件订阅白名单、跨天免打扰时段与同项目合批窗口的查询与乐观并发更新。
 * 尚未落库时返回默认配置（version=0），首次保存以 expectedVersion=0 初始化落库。
 */
@Service
public class NotificationPreferenceAppService {

    public static final List<String> DEFAULT_SUBSCRIBED_EVENTS = List.of(
            "task.assigned", "task.review_requested", "task.returned"
    );

    private final IdentityRepository identity;
    private final NotificationPreferenceRepository repository;
    private final Contracts contracts;
    private final Clock clock;

    @Autowired
    public NotificationPreferenceAppService(IdentityRepository identity, NotificationPreferenceRepository repository,
                                            Contracts contracts) {
        this(identity, repository, contracts, Clock.systemUTC());
    }

    NotificationPreferenceAppService(IdentityRepository identity, NotificationPreferenceRepository repository,
                                     Contracts contracts, Clock clock) {
        this.identity = identity;
        this.repository = repository;
        this.contracts = contracts;
        this.clock = clock;
    }

    public static NotificationPreferences defaults() {
        return new NotificationPreferences(
                true,
                DEFAULT_SUBSCRIBED_EVENTS,
                false,
                1320,
                540,
                "Asia/Shanghai",
                60,
                0L
        );
    }

    @Transactional(readOnly = true)
    public NotificationPreferences get(String userId) {
        requireActiveUser(userId);
        return repository.findByUserId(userId).orElseGet(NotificationPreferenceAppService::defaults);
    }

    public String encode(NotificationPreferences preferences) {
        return contracts.encode("NotificationPreferences", preferences);
    }

    @Transactional
    public String update(String userId, String rawBody) {
        requireActiveUser(userId);
        NotificationPreferencesUpdateRequest request = contracts.decode(
                "NotificationPreferencesUpdateRequest", rawBody, NotificationPreferencesUpdateRequest.class);
        try {
            ZoneId.of(request.dndTimezone());
        } catch (DateTimeException invalidTimezone) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        if (!repository.upsertIfVersion(userId, request, clock.millis())) {
            throw new ApiProblem(409, "VERSION_CONFLICT");
        }
        NotificationPreferences saved = repository.findByUserId(userId)
                .orElseThrow(() -> new IllegalStateException("通知偏好保存后未能回读"));
        return encode(saved);
    }

    private void requireActiveUser(String userId) {
        identity.findUserById(userId)
                .filter(User::enabled)
                .orElseThrow(() -> new ApiProblem(401, "AUTHENTICATION_REQUIRED"));
    }
}
