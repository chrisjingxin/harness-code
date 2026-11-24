package workbench.collaboration.infrastructure.notification;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import workbench.collaboration.application.port.DeepLinkBuilder;
import workbench.collaboration.application.port.ExternalNotificationChannel;
import workbench.collaboration.application.port.ExternalNotificationMessage;
import workbench.collaboration.application.port.ExternalNotificationRepository;
import workbench.collaboration.application.port.ExternalRecipient;
import workbench.collaboration.application.port.ExternalRecipientResolver;
import workbench.collaboration.application.port.InboxActionabilityChecker;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.application.service.ExternalNotificationDispatcher;
import workbench.collaboration.application.service.ExternalNotificationEnqueuer;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.support.FakeStores;
import workbench.collaboration.support.FakeStores.FakeProjects;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Spring 集成与 SPI 可扩展性验证：
 * 1) 默认上下文自动注册 Noop/Logging 通道、工号解析器与 workbench:// 深链接构造器，开箱可用；
 * 2) 企业侧只需注册自定义 ExternalNotificationChannel（及可选 DeepLinkBuilder / ExternalRecipientResolver）
 *    并更改配置项，零改动业务代码即可收到脱敏轻通知卡片与自定义内网跳转地址。
 */
class ExternalChannelExtensionTest {

    private static final String WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROJ = "10000000-0000-4000-8000-000000000001";
    private static final String TASK = "20000000-0000-4000-8000-000000000001";
    private static final String ACTOR = "11111111111141118111111111111111";
    private static final String RECIPIENT = "22222222222242228222222222222222";

    private final ApplicationContextRunner baseRunner = new ApplicationContextRunner()
            .withUserConfiguration(
                    PropertiesConfig.class,
                    ExternalNotificationConfig.class,
                    SafeNotificationBuilder.class,
                    NoopNotificationChannel.class,
                    LoggingNotificationChannel.class,
                    ExternalNotificationEnqueuer.class,
                    ExternalNotificationDispatcher.class,
                    TestInfrastructureStubs.class
            );

    @Test
    void 默认装配开箱提供Noop与Logging通道及默认SPI() {
        baseRunner.run(context -> {
            assertThat(context).hasSingleBean(ExternalRecipientResolver.class);
            assertThat(context.getBean(ExternalRecipientResolver.class)).isInstanceOf(UserNoRecipientResolver.class);
            assertThat(context).hasSingleBean(DeepLinkBuilder.class);
            assertThat(context.getBean(DeepLinkBuilder.class)).isInstanceOf(WorkbenchSchemeDeepLinkBuilder.class);
            assertThat(context.getBeansOfType(ExternalNotificationChannel.class)).containsKeys("noopNotificationChannel", "loggingNotificationChannel");

            ExternalNotificationEnqueuer enqueuer = context.getBean(ExternalNotificationEnqueuer.class);
            ExternalNotificationDispatcher dispatcher = context.getBean(ExternalNotificationDispatcher.class);

            long past = System.currentTimeMillis() - 120_000L;
            enqueuer.enqueueTaskEvent(WS, PROJ, TASK, "task.assigned", RECIPIENT, ACTOR,
                    ExternalNotificationRepository.URGENCY_NORMAL, "默认Noop测试", past);
            assertThat(dispatcher.dispatchDueBatch()).isEqualTo(1);
        });
    }

    @Test
    void 注入自定义企业IM通道与网关链接构造器零改业务代码即可收卡() {
        baseRunner
                .withUserConfiguration(CustomCorpImConfig.class)
                .withPropertyValues(
                        "workbench.notifications.external.enabled=true",
                        "workbench.notifications.external.channel=corp-im",
                        "workbench.notifications.external.default-merge-window-sec=0"
                )
                .run(context -> {
                    assertThat(context.getBean(ExternalRecipientResolver.class)).isInstanceOf(CorpEmailResolver.class);
                    assertThat(context.getBean(DeepLinkBuilder.class)).isInstanceOf(CorpGatewayDeepLinkBuilder.class);

                    ExternalNotificationEnqueuer enqueuer = context.getBean(ExternalNotificationEnqueuer.class);
                    ExternalNotificationDispatcher dispatcher = context.getBean(ExternalNotificationDispatcher.class);
                    CorpImChannel corpChannel = context.getBean(CorpImChannel.class);

                    long past = System.currentTimeMillis() - 10_000L;
                    enqueuer.enqueueTaskEvent(WS, PROJ, TASK, "task.review_requested", RECIPIENT, ACTOR,
                            ExternalNotificationRepository.URGENCY_URGENT, "生产灰度前回归确认", past);

                    int sent = dispatcher.dispatchDueBatch();
                    assertThat(sent).isEqualTo(1);
                    assertThat(corpChannel.received).hasSize(1);

                    ExternalNotificationMessage card = corpChannel.received.getFirst();
                    assertThat(card.urgency()).isEqualTo("urgent");
                    assertThat(card.recipient().externalAccountId()).isEqualTo("80278668@corp.internal");
                    assertThat(card.summary()).contains("沈北辰").contains("支付重构").contains("生产灰度前回归确认");
                    assertThat(card.deepLink()).startsWith("https://im-jump.corp.internal/workbench?target=");
                });
    }

    @Configuration
    @EnableConfigurationProperties(WorkbenchProperties.class)
    static class PropertiesConfig {}

    @Configuration
    static class CustomCorpImConfig {
        @Bean
        CorpImChannel corpImChannel() {
            return new CorpImChannel();
        }

        @Bean
        ExternalRecipientResolver corpEmailResolver() {
            return new CorpEmailResolver();
        }

        @Bean
        DeepLinkBuilder corpGatewayDeepLinkBuilder() {
            return new CorpGatewayDeepLinkBuilder();
        }
    }

    static class CorpImChannel implements ExternalNotificationChannel {
        final List<ExternalNotificationMessage> received = new ArrayList<>();

        @Override public String channelType() { return "corp-im"; }

        @Override
        public DeliveryResult send(ExternalNotificationMessage message) {
            received.add(message);
            return DeliveryResult.sent("corp-msg-" + received.size());
        }
    }

    static class CorpEmailResolver implements ExternalRecipientResolver {
        @Override
        public Optional<ExternalRecipient> resolve(User user) {
            if (!user.enabled() || user.userNo().isBlank()) return Optional.empty();
            return Optional.of(new ExternalRecipient(
                    user.id(), user.userNo(), user.userName(), user.userNo() + "@corp.internal"));
        }
    }

    static class CorpGatewayDeepLinkBuilder implements DeepLinkBuilder {
        private final WorkbenchSchemeDeepLinkBuilder delegate = new WorkbenchSchemeDeepLinkBuilder();

        @Override
        public String buildTaskLink(String workspaceId, String projectId, String taskId) {
            String raw = delegate.buildTaskLink(workspaceId, projectId, taskId);
            return "https://im-jump.corp.internal/workbench?target=" + URLEncoder.encode(raw, StandardCharsets.UTF_8);
        }

        @Override
        public String buildInboxLink() {
            return "https://im-jump.corp.internal/workbench?target="
                    + URLEncoder.encode(delegate.buildInboxLink(), StandardCharsets.UTF_8);
        }
    }

    @Configuration
    static class TestInfrastructureStubs {
        @Bean
        ExternalNotificationRepository externalNotificationRepository() {
            return new StubExternalRepo();
        }

        @Bean
        NotificationPreferenceRepository notificationPreferenceRepository() {
            return new NotificationPreferenceRepository() {
                @Override
                public Optional<workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences> findByUserId(String userId) {
                    return Optional.empty();
                }

                @Override
                public boolean upsertIfVersion(String userId, workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest request, long nowMs) {
                    return false;
                }
            };
        }

        @Bean
        IdentityRepository identityRepository() {
            return new StubIdentity();
        }

        @Bean
        ProjectRepository projectRepository() {
            FakeProjects projects = new FakeProjects();
            projects.insert(new Project(PROJ, WS, "支付重构", "说明", ACTOR, ProjectStatus.ACTIVE, 1, 1, 1));
            return projects;
        }

        @Bean
        InboxActionabilityChecker alwaysActionableChecker() {
            return new InboxActionabilityChecker() {
                @Override public boolean supports(String eventType) { return true; }
                @Override public boolean isStillActionable(String u, String w, String p, String e, String o) { return true; }
            };
        }
    }

    private static final class StubIdentity implements IdentityRepository {
        private final User actor = FakeStores.user(ACTOR, "80278667", "沈北辰", true);
        private final User recipient = FakeStores.user(RECIPIENT, "80278668", "张景新", true);
        private final Workspace ws = new Workspace(WS, "arch", "平台架构二组", ACTOR, 1, 1);

        @Override public Optional<User> findUserById(String id) {
            if (ACTOR.equals(id)) return Optional.of(actor);
            if (RECIPIENT.equals(id)) return Optional.of(recipient);
            return Optional.empty();
        }
        @Override public Optional<User> findUserByUserNo(String userNo) { return Optional.empty(); }
        @Override public void insertUser(User user) {}
        @Override public Optional<workbench.collaboration.domain.identity.Org> findOrgById(String orgId) { return Optional.empty(); }
        @Override public void insertOrg(workbench.collaboration.domain.identity.Org org) {}
        @Override public boolean userOrgExists(String userId, String orgId) { return false; }
        @Override public void insertUserOrg(workbench.collaboration.domain.identity.UserOrg userOrg) {}
        @Override public Optional<Workspace> findWorkspaceById(String id) { return WS.equals(id) ? Optional.of(ws) : Optional.empty(); }
        @Override public Optional<Workspace> findWorkspaceBySlug(String slug) { return Optional.empty(); }
        @Override public void insertWorkspace(Workspace workspace) {}
        @Override public boolean memberExists(String workspaceId, String userId) { return WS.equals(workspaceId); }
        @Override public void insertMember(workbench.collaboration.domain.identity.WorkspaceMember member) {}
        @Override public void lockWorkspace(String workspaceId) {}
        @Override public Optional<workbench.collaboration.domain.identity.WorkspaceMember> findMember(String workspaceId, String userId) { return Optional.empty(); }
        @Override public List<User> listDemoUsers() { return List.of(); }
        @Override public List<Workspace> listWorkspacesForUser(String userId) { return List.of(ws); }
        @Override public List<User> listMembers(String workspaceId) { return List.of(actor, recipient); }
    }

    private static final class StubExternalRepo implements ExternalNotificationRepository {
        private final List<DeliveryRecord> records = new ArrayList<>();

        @Override
        public void enqueue(NewDelivery d) {
            records.add(new DeliveryRecord(
                    records.size() + 1L, d.deliveryId(), d.userId(), d.workspaceId(), d.projectId(),
                    d.eventType(), d.objectId(), d.actorId(), d.urgency(), d.titleSnapshot(),
                    d.mergeKey(), STATUS_PENDING, "", 0, d.maxAttempts(), d.availableAtMs(), "", d.occurredAtMs()));
        }

        @Override public int cancelPendingByObject(String objectId, String skipReason, long nowMs) { return 0; }
        @Override public int cancelPendingByObjectAndUser(String objectId, String userId, String skipReason, long nowMs) { return 0; }
        @Override public int cancelPendingByWorkspaceAndUser(String workspaceId, String userId, String skipReason, long nowMs) { return 0; }

        @Override
        public List<DeliveryRecord> claimDueBatch(long nowMs, int limit) {
            List<DeliveryRecord> claimed = new ArrayList<>();
            for (int i = 0; i < records.size() && claimed.size() < limit; i++) {
                DeliveryRecord r = records.get(i);
                if (r.status() == STATUS_PENDING && r.availableAtMs() <= nowMs) {
                    DeliveryRecord next = new DeliveryRecord(
                            r.rowId(), r.deliveryId(), r.userId(), r.workspaceId(), r.projectId(),
                            r.eventType(), r.objectId(), r.actorId(), r.urgency(), r.titleSnapshot(),
                            r.mergeKey(), STATUS_SENDING, r.skipReason(), r.attemptCount(), r.maxAttempts(),
                            r.availableAtMs(), r.lastError(), r.occurredAtMs());
                    records.set(i, next);
                    claimed.add(next);
                }
            }
            return claimed;
        }

        @Override public List<DeliveryRecord> claimPendingInMergeGroup(String userId, String mergeKey, long nowMs) { return List.of(); }
        @Override public Optional<DeliveryRecord> findByDeliveryId(String deliveryId) { return Optional.empty(); }
        @Override public void markSent(List<Long> rowIds, long nowMs) {}
        @Override public void markSkipped(List<Long> rowIds, String skipReason, long nowMs) {}
        @Override public void markDeferred(List<Long> rowIds, long nextAvailableAtMs, long nowMs) {}
        @Override public void markRetry(List<Long> rowIds, int nextAttemptCount, long nextAvailableAtMs, String lastError, long nowMs) {}
        @Override public void markFailed(List<Long> rowIds, int attemptCount, String lastError, long nowMs) {}
    }
}
