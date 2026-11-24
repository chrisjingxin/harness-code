package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import workbench.collaboration.application.port.ExternalNotificationChannel;
import workbench.collaboration.application.port.ExternalNotificationMessage;
import workbench.collaboration.application.port.ExternalNotificationRepository;
import workbench.collaboration.application.port.InboxActionabilityChecker;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.notification.SafeNotificationBuilder;
import workbench.collaboration.infrastructure.notification.UserNoRecipientResolver;
import workbench.collaboration.infrastructure.notification.WorkbenchSchemeDeepLinkBuilder;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest;
import workbench.collaboration.support.FakeStores;
import workbench.collaboration.support.FakeStores.FakeProjects;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 外部通知出站调度引擎全链路单元测试：
 * 覆盖 60 秒合批合并、等待窗口内已办取消推送（现态复核消噪）、跨天免打扰顺延、
 * 开关/订阅过滤、UserNoRecipientResolver 工号寻址与空工号跳过、指数退避重试及永久失败停发。
 */
class ExternalNotificationDispatcherTest {

    private static final String WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROJ = "10000000-0000-4000-8000-000000000001";
    private static final String TASK_1 = "20000000-0000-4000-8000-000000000001";
    private static final String TASK_2 = "20000000-0000-4000-8000-000000000002";
    private static final String TASK_3 = "20000000-0000-4000-8000-000000000003";
    private static final String ACTOR = "11111111111141118111111111111111";
    private static final String RECIPIENT = "22222222222242228222222222222222";
    private static final String NO_USER_NO = "33333333333343338333333333333333";

    private InMemoryExternalRepo repo;
    private InMemoryPrefRepo prefRepo;
    private TestIdentity identity;
    private FakeProjects projects;
    private StubActionabilityChecker checker;
    private RecordingChannel channel;
    private MutableClock clock;
    private WorkbenchProperties properties;
    private ExternalNotificationDispatcher dispatcher;

    @BeforeEach
    void setUp() {
        repo = new InMemoryExternalRepo();
        prefRepo = new InMemoryPrefRepo();
        identity = new TestIdentity();
        projects = new FakeProjects();
        checker = new StubActionabilityChecker();
        channel = new RecordingChannel();
        // 2026-11-24 14:00:00+08:00（默认非免打扰白天工作时段）
        long initialMs = ZonedDateTime.of(2026, 11, 24, 14, 0, 0, 0, ZoneId.of("Asia/Shanghai"))
                .toInstant().toEpochMilli();
        clock = new MutableClock(initialMs);

        identity.users.put(ACTOR, FakeStores.user(ACTOR, "80278667", "沈北辰", true));
        identity.users.put(RECIPIENT, FakeStores.user(RECIPIENT, "80278668", "张景新", true));
        identity.users.put(NO_USER_NO, FakeStores.user(NO_USER_NO, "", "未绑工号成员", true));
        identity.workspaces.put(WS, new Workspace(WS, "arch", "平台架构二组", ACTOR, 1, 1));
        identity.addMember(WS, ACTOR);
        identity.addMember(WS, RECIPIENT);
        identity.addMember(WS, NO_USER_NO);

        projects.insert(new Project(PROJ, WS, "支付重构", "说明", ACTOR, ProjectStatus.ACTIVE, 1, 1, 1));

        properties = new WorkbenchProperties();
        properties.getNotifications().getExternal().setEnabled(true);
        properties.getNotifications().getExternal().setChannel("test-im");
        properties.getNotifications().getExternal().setDefaultMergeWindowSec(60);
        properties.getNotifications().getExternal().setMaxAttempts(3);

        dispatcher = new ExternalNotificationDispatcher(
                repo,
                prefRepo,
                identity,
                projects,
                List.of(checker),
                new UserNoRecipientResolver(),
                new SafeNotificationBuilder(new WorkbenchSchemeDeepLinkBuilder()),
                List.of(channel),
                properties,
                clock
        );
    }

    @Test
    void 同项目60秒窗口多条同类事件自动合并为1条汇总卡片() {
        ExternalNotificationEnqueuer enqueuer = new ExternalNotificationEnqueuer(repo, prefRepo, properties);
        long t0 = clock.millis();
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_1, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "任务一：核对账单", t0);
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_2, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "任务二：补齐单测", t0 + 5_000);
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_3, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "任务三：更新文档", t0 + 10_000);

        // 未到 60s 窗口前不发送
        clock.setMillis(t0 + 59_000);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        assertThat(channel.sentMessages).isEmpty();

        // 超过第一条 60s 窗口后触发调度：同项目同类突发的 3 条记录全部聚拢为 1 条汇总卡片
        clock.setMillis(t0 + 61_000);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(1);
        assertThat(channel.sentMessages).hasSize(1);

        ExternalNotificationMessage card = channel.sentMessages.getFirst();
        assertThat(card.mergedCount()).isEqualTo(3);
        assertThat(card.recipient().externalAccountId()).isEqualTo("80278668");
        assertThat(card.deepLink()).isEqualTo("workbench://open/inbox");
        assertThat(card.summary()).contains("3 项新任务指派给你").contains("任务三：更新文档");

        long sentCount = repo.records.stream().filter(r -> r.status() == ExternalNotificationRepository.STATUS_SENT).count();
        long mergedCount = repo.records.stream()
                .filter(r -> r.status() == ExternalNotificationRepository.STATUS_SKIPPED && "merged_into_batch".equals(r.skipReason()))
                .count();
        assertThat(sentCount).isEqualTo(1);
        assertThat(mergedCount).isEqualTo(2);
    }

    @Test
    void 窗口内已办或已取消在发送前复核自动取消推送() {
        ExternalNotificationEnqueuer enqueuer = new ExternalNotificationEnqueuer(repo, prefRepo, properties);
        long t0 = clock.millis();
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_1, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "已被接收的任务", t0);

        // 用户在 60s 等待窗口内自己点开接收了，现态复核返回 false
        checker.actionable = false;
        clock.setMillis(t0 + 65_000);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        assertThat(channel.sentMessages).isEmpty();
        assertThat(repo.records.getFirst().status()).isEqualTo(ExternalNotificationRepository.STATUS_SKIPPED);
        assertThat(repo.records.getFirst().skipReason()).isEqualTo("already_resolved");
    }

    @Test
    void 跨午夜免打扰顺延至结束时刻并在关闭开关或退订时跳过() {
        // 设定 22:00 ~ 09:00 Asia/Shanghai 免打扰，合批窗口 0 秒
        prefRepo.upsertIfVersion(RECIPIENT, new NotificationPreferencesUpdateRequest(
                true, List.of("task.assigned", "task.review_requested"), true,
                1320, 540, "Asia/Shanghai", 0, 0L), clock.millis());

        // 当前拨到 2026-11-24 22:30:00+08:00（免打扰期间）
        long nightMs = ZonedDateTime.of(2026, 11, 24, 22, 30, 0, 0, ZoneId.of("Asia/Shanghai"))
                .toInstant().toEpochMilli();
        long expectedMorningMs = ZonedDateTime.of(2026, 11, 25, 9, 0, 0, 0, ZoneId.of("Asia/Shanghai"))
                .toInstant().toEpochMilli();
        clock.setMillis(nightMs);

        ExternalNotificationEnqueuer enqueuer = new ExternalNotificationEnqueuer(repo, prefRepo, properties);
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_1, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "夜间指派", nightMs);

        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        assertThat(channel.sentMessages).isEmpty();
        assertThat(repo.records.getFirst().status()).isEqualTo(ExternalNotificationRepository.STATUS_PENDING);
        assertThat(repo.records.getFirst().availableAtMs()).isEqualTo(expectedMorningMs);
        assertThat(repo.records.getFirst().attemptCount()).isEqualTo(0);

        // 拨到次日 09:00:00+08:00（免打扰结束）后正常发出
        clock.setMillis(expectedMorningMs);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(1);
        assertThat(channel.sentMessages).hasSize(1);
        assertThat(channel.sentMessages.getFirst().deepLink()).isEqualTo(
                "workbench://open/task?workspaceId=" + WS + "&projectId=" + PROJ + "&taskId=" + TASK_1);

        // 未订阅事件 task.returned 自动跳过 unsubscribed
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_2, "task.returned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "未订阅事件", expectedMorningMs);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        assertThat(repo.records.get(1).skipReason()).isEqualTo("unsubscribed");

        // 总开关关闭自动跳过 disabled
        prefRepo.upsertIfVersion(RECIPIENT, new NotificationPreferencesUpdateRequest(
                false, List.of("task.assigned"), false,
                1320, 540, "Asia/Shanghai", 0, 1L), expectedMorningMs);
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_3, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "总开关已关", expectedMorningMs);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        assertThat(repo.records.get(2).skipReason()).isEqualTo("disabled");
    }

    @Test
    void 无工号用户记录recipient_unmapped_重试遵循30s_120s_300s退避与失败上限() {
        prefRepo.upsertIfVersion(RECIPIENT, new NotificationPreferencesUpdateRequest(
                true, List.of("task.assigned"), false, 1320, 540, "Asia/Shanghai", 0, 0L), clock.millis());
        prefRepo.upsertIfVersion(NO_USER_NO, new NotificationPreferencesUpdateRequest(
                true, List.of("task.assigned"), false, 1320, 540, "Asia/Shanghai", 0, 0L), clock.millis());

        ExternalNotificationEnqueuer enqueuer = new ExternalNotificationEnqueuer(repo, prefRepo, properties);
        long t0 = clock.millis();

        // 1) 未绑工号跳过
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_1, "task.assigned", NO_USER_NO, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "无工号测试", t0);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        assertThat(repo.records.getFirst().status()).isEqualTo(ExternalNotificationRepository.STATUS_SKIPPED);
        assertThat(repo.records.getFirst().skipReason()).isEqualTo("recipient_unmapped");

        // 2) 验证 30s / 120s / 300s 退避及 maxAttempts=3 达上限后转 failed
        assertThat(ExternalNotificationDispatcher.backoffMs(1)).isEqualTo(30_000L);
        assertThat(ExternalNotificationDispatcher.backoffMs(2)).isEqualTo(120_000L);
        assertThat(ExternalNotificationDispatcher.backoffMs(3)).isEqualTo(300_000L);

        channel.nextResult = ExternalNotificationChannel.DeliveryResult.retryableFailure("im_timeout_504");
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_2, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "退避重试测试", t0);

        // 第 1 次失败 -> 退避 30s
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        var rec = repo.records.get(1);
        assertThat(rec.status()).isEqualTo(ExternalNotificationRepository.STATUS_PENDING);
        assertThat(rec.attemptCount()).isEqualTo(1);
        assertThat(rec.availableAtMs()).isEqualTo(t0 + 30_000L);

        // 第 2 次失败 -> 退避 120s
        clock.setMillis(t0 + 30_000L);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        rec = repo.records.get(1);
        assertThat(rec.status()).isEqualTo(ExternalNotificationRepository.STATUS_PENDING);
        assertThat(rec.attemptCount()).isEqualTo(2);
        assertThat(rec.availableAtMs()).isEqualTo(t0 + 150_000L);

        // 第 3 次失败（达到 maxAttempts=3）-> 终态 failed
        clock.setMillis(t0 + 150_000L);
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        rec = repo.records.get(1);
        assertThat(rec.status()).isEqualTo(ExternalNotificationRepository.STATUS_FAILED);
        assertThat(rec.attemptCount()).isEqualTo(3);
        assertThat(rec.lastError()).contains("max_attempts_exceeded");

        // 3) 永久失败立即停发不重试
        channel.nextResult = ExternalNotificationChannel.DeliveryResult.permanentFailure("user_rejected");
        enqueuer.enqueueTaskEvent(WS, PROJ, TASK_3, "task.assigned", RECIPIENT, ACTOR,
                ExternalNotificationRepository.URGENCY_NORMAL, "永久失败测试", clock.millis());
        assertThat(dispatcher.dispatchDueBatch()).isEqualTo(0);
        var perm = repo.records.get(2);
        assertThat(perm.status()).isEqualTo(ExternalNotificationRepository.STATUS_FAILED);
        assertThat(perm.attemptCount()).isEqualTo(1);
        assertThat(perm.lastError()).isEqualTo("user_rejected");
    }

    private static final class RecordingChannel implements ExternalNotificationChannel {
        final List<ExternalNotificationMessage> sentMessages = new ArrayList<>();
        DeliveryResult nextResult;

        @Override public String channelType() { return "test-im"; }

        @Override
        public DeliveryResult send(ExternalNotificationMessage message) {
            if (nextResult != null) {
                return nextResult;
            }
            sentMessages.add(message);
            return DeliveryResult.sent("msg-" + sentMessages.size());
        }
    }

    private static final class StubActionabilityChecker implements InboxActionabilityChecker {
        boolean actionable = true;

        @Override public boolean supports(String eventType) { return true; }

        @Override
        public boolean isStillActionable(String userId, String workspaceId, String projectId, String eventType, String objectId) {
            return actionable;
        }
    }

    private static final class MutableClock extends Clock {
        private final AtomicLong millis;

        MutableClock(long initialMs) { this.millis = new AtomicLong(initialMs); }

        void setMillis(long value) { millis.set(value); }

        @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(millis.get()); }
        @Override public long millis() { return millis.get(); }
    }

    private static final class TestIdentity implements workbench.collaboration.domain.identity.IdentityRepository {
        final Map<String, User> users = new HashMap<>();
        final Map<String, Workspace> workspaces = new HashMap<>();
        final List<String> members = new ArrayList<>();

        void addMember(String wsId, String userId) { members.add(wsId + ":" + userId); }

        @Override public Optional<User> findUserById(String id) { return Optional.ofNullable(users.get(id)); }
        @Override public Optional<User> findUserByUserNo(String userNo) { return Optional.empty(); }
        @Override public void insertUser(User user) {}
        @Override public Optional<workbench.collaboration.domain.identity.Org> findOrgById(String orgId) { return Optional.empty(); }
        @Override public void insertOrg(workbench.collaboration.domain.identity.Org org) {}
        @Override public boolean userOrgExists(String userId, String orgId) { return false; }
        @Override public void insertUserOrg(workbench.collaboration.domain.identity.UserOrg userOrg) {}
        @Override public Optional<Workspace> findWorkspaceById(String id) { return Optional.ofNullable(workspaces.get(id)); }
        @Override public Optional<Workspace> findWorkspaceBySlug(String slug) { return Optional.empty(); }
        @Override public void insertWorkspace(Workspace workspace) {}
        @Override public boolean memberExists(String workspaceId, String userId) { return members.contains(workspaceId + ":" + userId); }
        @Override public void insertMember(workbench.collaboration.domain.identity.WorkspaceMember member) {}
        @Override public void lockWorkspace(String workspaceId) {}
        @Override public Optional<workbench.collaboration.domain.identity.WorkspaceMember> findMember(String workspaceId, String userId) { return Optional.empty(); }
        @Override public List<User> listDemoUsers() { return List.of(); }
        @Override public List<Workspace> listWorkspacesForUser(String userId) { return List.of(); }
        @Override public List<User> listMembers(String workspaceId) { return List.of(); }
    }

    private static final class InMemoryPrefRepo implements NotificationPreferenceRepository {
        final Map<String, NotificationPreferences> store = new HashMap<>();

        @Override
        public Optional<NotificationPreferences> findByUserId(String userId) {
            return Optional.ofNullable(store.get(userId));
        }

        @Override
        public boolean upsertIfVersion(String userId, NotificationPreferencesUpdateRequest req, long nowMs) {
            NotificationPreferences existing = store.get(userId);
            if (req.expectedVersion() == 0 && existing != null) return false;
            if (req.expectedVersion() > 0 && (existing == null || existing.version() != req.expectedVersion())) return false;
            long nextVer = existing == null ? 1L : existing.version() + 1L;
            store.put(userId, new NotificationPreferences(
                    req.externalEnabled(), List.copyOf(req.subscribedEvents()),
                    req.dndEnabled(), req.dndStartMinute(), req.dndEndMinute(),
                    req.dndTimezone(), req.mergeWindowSec(), nextVer));
            return true;
        }
    }

    private static final class InMemoryExternalRepo implements ExternalNotificationRepository {
        final List<DeliveryRecord> records = new ArrayList<>();

        @Override
        public void enqueue(NewDelivery d) {
            records.add(new DeliveryRecord(
                    records.size() + 1L, d.deliveryId(), d.userId(), d.workspaceId(), d.projectId(),
                    d.eventType(), d.objectId(), d.actorId(), d.urgency(), d.titleSnapshot(),
                    d.mergeKey(), STATUS_PENDING, "", 0, d.maxAttempts(), d.availableAtMs(), "", d.occurredAtMs()));
        }

        @Override
        public int cancelPendingByObject(String objectId, String skipReason, long nowMs) {
            int n = 0;
            for (int i = 0; i < records.size(); i++) {
                DeliveryRecord r = records.get(i);
                if (r.objectId().equals(objectId) && r.status() == STATUS_PENDING) {
                    records.set(i, withStatus(r, STATUS_SKIPPED, skipReason, r.attemptCount(), r.availableAtMs(), r.lastError()));
                    n++;
                }
            }
            return n;
        }

        @Override public int cancelPendingByObjectAndUser(String objectId, String userId, String skipReason, long nowMs) { return 0; }
        @Override public int cancelPendingByWorkspaceAndUser(String workspaceId, String userId, String skipReason, long nowMs) { return 0; }

        @Override
        public List<DeliveryRecord> claimDueBatch(long nowMs, int limit) {
            List<DeliveryRecord> claimed = new ArrayList<>();
            List<DeliveryRecord> sorted = records.stream()
                    .filter(r -> r.status() == STATUS_PENDING && r.availableAtMs() <= nowMs)
                    .sorted(Comparator.comparingLong(DeliveryRecord::availableAtMs).thenComparingLong(DeliveryRecord::rowId))
                    .limit(limit)
                    .toList();
            for (DeliveryRecord candidate : sorted) {
                int idx = (int) candidate.rowId() - 1;
                DeliveryRecord updated = withStatus(candidate, STATUS_SENDING, candidate.skipReason(),
                        candidate.attemptCount(), candidate.availableAtMs(), candidate.lastError());
                records.set(idx, updated);
                claimed.add(updated);
            }
            return claimed;
        }

        @Override
        public List<DeliveryRecord> claimPendingInMergeGroup(String userId, String mergeKey, long nowMs) {
            List<DeliveryRecord> claimed = new ArrayList<>();
            for (int i = 0; i < records.size(); i++) {
                DeliveryRecord r = records.get(i);
                if (r.userId().equals(userId) && r.mergeKey().equals(mergeKey)
                        && r.status() == STATUS_PENDING && r.attemptCount() == 0) {
                    DeliveryRecord updated = withStatus(r, STATUS_SENDING, r.skipReason(),
                            r.attemptCount(), r.availableAtMs(), r.lastError());
                    records.set(i, updated);
                    claimed.add(updated);
                }
            }
            return claimed;
        }

        @Override
        public Optional<DeliveryRecord> findByDeliveryId(String deliveryId) {
            return records.stream().filter(r -> r.deliveryId().equals(deliveryId)).findFirst();
        }

        @Override
        public void markSent(List<Long> rowIds, long nowMs) {
            update(rowIds, r -> withStatus(r, STATUS_SENT, "", r.attemptCount(), r.availableAtMs(), ""));
        }

        @Override
        public void markSkipped(List<Long> rowIds, String skipReason, long nowMs) {
            update(rowIds, r -> withStatus(r, STATUS_SKIPPED, skipReason, r.attemptCount(), r.availableAtMs(), r.lastError()));
        }

        @Override
        public void markDeferred(List<Long> rowIds, long nextAvailableAtMs, long nowMs) {
            update(rowIds, r -> withStatus(r, STATUS_PENDING, r.skipReason(), r.attemptCount(), nextAvailableAtMs, r.lastError()));
        }

        @Override
        public void markRetry(List<Long> rowIds, int nextAttemptCount, long nextAvailableAtMs, String lastError, long nowMs) {
            update(rowIds, r -> withStatus(r, STATUS_PENDING, r.skipReason(), nextAttemptCount, nextAvailableAtMs, lastError));
        }

        @Override
        public void markFailed(List<Long> rowIds, int attemptCount, String lastError, long nowMs) {
            update(rowIds, r -> withStatus(r, STATUS_FAILED, r.skipReason(), attemptCount, r.availableAtMs(), lastError));
        }

        private void update(List<Long> rowIds, java.util.function.UnaryOperator<DeliveryRecord> fn) {
            for (Long id : rowIds) {
                int idx = id.intValue() - 1;
                records.set(idx, fn.apply(records.get(idx)));
            }
        }

        private static DeliveryRecord withStatus(DeliveryRecord r, int status, String skipReason,
                                                 int attempts, long avail, String err) {
            return new DeliveryRecord(
                    r.rowId(), r.deliveryId(), r.userId(), r.workspaceId(), r.projectId(),
                    r.eventType(), r.objectId(), r.actorId(), r.urgency(), r.titleSnapshot(),
                    r.mergeKey(), status, skipReason, attempts, r.maxAttempts(), avail, err, r.occurredAtMs());
        }
    }
}
