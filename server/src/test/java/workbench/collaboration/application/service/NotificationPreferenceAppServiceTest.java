package workbench.collaboration.application.service;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest;
import workbench.collaboration.support.FakeStores;
import workbench.collaboration.support.FakeStores.FakeIdentity;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 验证用户通知偏好服务：默认配置、首次初始化、版本递增、409 乐观锁冲突及非法时区/契约拦截。
 */
class NotificationPreferenceAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String ME = "11111111111141118111111111111111";

    @Test
    void 未配置返回默认值并支持乐观锁初始化与并发冲突409() {
        var identity = new FakeIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        var repo = new InMemoryPrefRepo();
        NotificationPreferenceAppService service = new NotificationPreferenceAppService(
                identity, repo, new Contracts(), Clock.fixed(Instant.ofEpochMilli(1000L), ZoneOffset.UTC));

        NotificationPreferences initial = service.get(ME);
        assertThat(initial.externalEnabled()).isTrue();
        assertThat(initial.mergeWindowSec()).isEqualTo(60);
        assertThat(initial.dndTimezone()).isEqualTo("Asia/Shanghai");
        assertThat(initial.version()).isEqualTo(0L);

        String saved1 = service.update(ME, """
                {
                  "externalEnabled": true,
                  "subscribedEvents": ["task.assigned", "task.review_requested"],
                  "dndEnabled": true,
                  "dndStartMinute": 1320,
                  "dndEndMinute": 540,
                  "dndTimezone": "Asia/Shanghai",
                  "mergeWindowSec": 30,
                  "expectedVersion": 0
                }
                """);
        var tree1 = JSON.readTree(saved1);
        assertThat(tree1.path("version").asLong()).isEqualTo(1L);
        assertThat(tree1.path("dndEnabled").asBoolean()).isTrue();
        assertThat(tree1.path("mergeWindowSec").asInt()).isEqualTo(30);

        // 过期 expectedVersion=0 必须返回 409 VERSION_CONFLICT
        assertThatThrownBy(() -> service.update(ME, """
                {
                  "externalEnabled": false,
                  "subscribedEvents": [],
                  "dndEnabled": false,
                  "dndStartMinute": 1320,
                  "dndEndMinute": 540,
                  "dndTimezone": "Asia/Shanghai",
                  "mergeWindowSec": 0,
                  "expectedVersion": 0
                }
                """))
                .isInstanceOf(ApiProblem.class)
                .extracting("status", "code")
                .containsExactly(409, "VERSION_CONFLICT");

        // 正常版本 1 -> 2
        String saved2 = service.update(ME, """
                {
                  "externalEnabled": false,
                  "subscribedEvents": [],
                  "dndEnabled": false,
                  "dndStartMinute": 1320,
                  "dndEndMinute": 540,
                  "dndTimezone": "UTC",
                  "mergeWindowSec": 0,
                  "expectedVersion": 1
                }
                """);
        assertThat(JSON.readTree(saved2).path("version").asLong()).isEqualTo(2L);
        assertThat(service.get(ME).externalEnabled()).isFalse();
    }

    @Test
    void 非法时区与越界参数被拒绝() {
        var identity = new FakeIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        NotificationPreferenceAppService service = new NotificationPreferenceAppService(
                identity, new InMemoryPrefRepo(), new Contracts(), Clock.systemUTC());

        assertThatThrownBy(() -> service.update(ME, """
                {
                  "externalEnabled": true,
                  "subscribedEvents": ["task.assigned"],
                  "dndEnabled": true,
                  "dndStartMinute": 1320,
                  "dndEndMinute": 540,
                  "dndTimezone": "Mars/Olympus",
                  "mergeWindowSec": 60,
                  "expectedVersion": 0
                }
                """))
                .isInstanceOf(ApiProblem.class)
                .extracting("status", "code")
                .containsExactly(400, "INVALID_REQUEST");

        assertThatThrownBy(() -> service.update(ME, """
                {
                  "externalEnabled": true,
                  "subscribedEvents": ["task.assigned"],
                  "dndEnabled": true,
                  "dndStartMinute": 1500,
                  "dndEndMinute": 540,
                  "dndTimezone": "Asia/Shanghai",
                  "mergeWindowSec": 60,
                  "expectedVersion": 0
                }
                """))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static final class InMemoryPrefRepo implements NotificationPreferenceRepository {
        final Map<String, NotificationPreferences> data = new HashMap<>();

        @Override
        public Optional<NotificationPreferences> findByUserId(String userId) {
            return Optional.ofNullable(data.get(userId));
        }

        @Override
        public boolean upsertIfVersion(String userId, NotificationPreferencesUpdateRequest request, long nowMs) {
            NotificationPreferences existing = data.get(userId);
            if (request.expectedVersion() == 0) {
                if (existing != null) return false;
                data.put(userId, new NotificationPreferences(
                        request.externalEnabled(), List.copyOf(request.subscribedEvents()),
                        request.dndEnabled(), request.dndStartMinute(), request.dndEndMinute(),
                        request.dndTimezone(), request.mergeWindowSec(), 1L));
                return true;
            }
            if (existing == null || existing.version() != request.expectedVersion()) {
                return false;
            }
            data.put(userId, new NotificationPreferences(
                    request.externalEnabled(), List.copyOf(request.subscribedEvents()),
                    request.dndEnabled(), request.dndStartMinute(), request.dndEndMinute(),
                    request.dndTimezone(), request.mergeWindowSec(), existing.version() + 1));
            return true;
        }
    }
}
