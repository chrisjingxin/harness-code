package workbench.collaboration.application.service;

import org.junit.jupiter.api.Test;
import workbench.collaboration.application.port.ExternalNotificationRepository;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.task.TaskStatus;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.TaskStore;
import workbench.collaboration.interfaces.dto.TaskDtos.TaskSummary;
import workbench.collaboration.support.FakeStores;
import workbench.collaboration.support.FakeStores.FakeConversations;
import workbench.collaboration.support.FakeStores.FakeIdentity;
import workbench.collaboration.support.FakeStores.FakeProjects;
import workbench.collaboration.support.FakeStores.FakeRepositories;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 验证 HC-246 对 TaskAppService 离职代管验收通知接收人的补全与外部队列入队/消噪联动：
 * 原创建人停用或离开团队时，保持 wb_notification_outbox 事件名不变，将端内通知与外部待验收轻通知
 * 路由到有效 Project owner；任务完结时自动消噪未发出的外部 pending 记录。
 */
class TaskAppServiceDelegationTest {

    private static final String WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROJECT = "10000000-0000-4000-8000-000000000001";
    private static final String TASK_ID = "20000000-0000-4000-8000-000000000001";
    private static final String OWNER = "11111111111141118111111111111111";
    private static final String CREATOR = "22222222222242228222222222222222";
    private static final String ASSIGNEE = "33333333333343338333333333333333";

    @Test
    void 原发起人停用或移出团队后提交验收通知路由给ProjectOwner并在终结时自动消噪() {
        var identity = new FakeIdentity();
        identity.users.put(OWNER, FakeStores.user(OWNER, "80278667", "项目负责人", true));
        identity.users.put(CREATOR, FakeStores.user(CREATOR, "80278668", "已离职发起人", false));
        identity.users.put(ASSIGNEE, FakeStores.user(ASSIGNEE, "80278669", "受让人", true));
        identity.addMember(WS, OWNER);
        identity.addMember(WS, ASSIGNEE);

        var projects = new FakeProjects();
        projects.insert(new Project(PROJECT, WS, "核心项目", "说明", OWNER, ProjectStatus.ACTIVE, 1, 1, 1));
        projects.upsertMember(new ProjectMember(PROJECT, OWNER, MemberStatus.ACTIVE, 1, 1));
        projects.upsertMember(new ProjectMember(PROJECT, ASSIGNEE, MemberStatus.ACTIVE, 1, 1));

        String reqReview = "00000000-0000-4000-8000-0000000000a1";
        String bodyReview = "{\"targetStatus\":\"review\",\"expectedVersion\":2,\"requestId\":\"" + reqReview + "\"}";
        String reqDone = "00000000-0000-4000-8000-0000000000a2";
        String bodyDone = "{\"targetStatus\":\"done\",\"expectedVersion\":3,\"requestId\":\"" + reqDone + "\"}";

        TaskStore taskStore = mock(TaskStore.class);
        when(taskStore.claim(eq(PROJECT), eq(ASSIGNEE), eq(reqReview), anyString()))
                .thenReturn(new TaskStore.Receipt(IdempotentCalls.fingerprint("transition", TASK_ID, bodyReview), ""));
        when(taskStore.claim(eq(PROJECT), eq(OWNER), eq(reqDone), anyString()))
                .thenReturn(new TaskStore.Receipt(IdempotentCalls.fingerprint("transition", TASK_ID, bodyDone), ""));

        var doingSummary = new TaskSummary(TASK_ID, PROJECT, "接口联调", CREATOR, ASSIGNEE, TaskStatus.DOING.wire, 2, null, 100L, 200L);
        var reviewSummary = new TaskSummary(TASK_ID, PROJECT, "接口联调", CREATOR, ASSIGNEE, TaskStatus.REVIEW.wire, 3, null, 100L, 300L);
        when(taskStore.find(PROJECT, TASK_ID))
                .thenReturn(Optional.of(new TaskStore.StoredTask(doingSummary, "详细说明")))
                .thenReturn(Optional.of(new TaskStore.StoredTask(reviewSummary, "详细说明")));
        when(taskStore.update(eq(PROJECT), eq(TASK_ID), anyLong(), anyString(), any(), any(), anyLong()))
                .thenReturn(true);
        when(taskStore.detail(any())).thenAnswer(invocation -> {
            TaskStore.StoredTask s = invocation.getArgument(0);
            return new workbench.collaboration.interfaces.dto.TaskDtos.TaskDetail(
                    s.summary(), s.description(), List.of(), List.of(), List.of());
        });

        List<Map<String, Object>> published = new ArrayList<>();
        List<String> eventTypes = new ArrayList<>();
        NotificationPort notifications = (eventType, subjectId, payload) -> {
            eventTypes.add(eventType);
            published.add(payload);
        };

        var externalRepo = new CapturingExternalRepo();
        NotificationPreferenceRepository prefRepo = new NotificationPreferenceRepository() {
            @Override
            public Optional<workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences> findByUserId(String userId) {
                return Optional.empty();
            }

            @Override
            public boolean upsertIfVersion(String userId, workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferencesUpdateRequest request, long nowMs) {
                return false;
            }
        };
        ExternalNotificationEnqueuer enqueuer = new ExternalNotificationEnqueuer(
                externalRepo, prefRepo, new WorkbenchProperties());

        TaskAppService service = new TaskAppService(
                new ProjectAccessPolicy(identity, projects, new FakeRepositories()),
                identity,
                new FakeConversations(),
                mock(workbench.collaboration.domain.snapshot.SnapshotRepository.class),
                mock(workbench.collaboration.infrastructure.persistence.KnowledgeStore.class),
                taskStore,
                notifications,
                enqueuer,
                new Contracts()
        );

        // 1) doing -> review：原创建人已离职停用，通知与外部轻通知均路由给代管 Project owner
        service.transition(ASSIGNEE, WS, PROJECT, TASK_ID, bodyReview);

        assertThat(eventTypes).containsExactly("task.changed");
        assertThat(published).hasSize(1);
        assertThat(published.getFirst().get("creatorId")).isEqualTo(OWNER);
        assertThat(published.getFirst().get("assigneeId")).isEqualTo(ASSIGNEE);
        assertThat(externalRepo.records).hasSize(1);
        assertThat(externalRepo.records.getFirst().eventType()).isEqualTo("task.review_requested");
        assertThat(externalRepo.records.getFirst().userId()).isEqualTo(OWNER);
        assertThat(externalRepo.records.getFirst().urgency()).isEqualTo(ExternalNotificationRepository.URGENCY_URGENT);
        assertThat(externalRepo.records.getFirst().status()).isEqualTo(ExternalNotificationRepository.STATUS_PENDING);

        // 2) review -> done：任务完结时自动将同对象尚未发出的 pending 记录置为 skipped(already_resolved)
        service.transition(OWNER, WS, PROJECT, TASK_ID, bodyDone);
        assertThat(externalRepo.records).hasSize(1);
        assertThat(externalRepo.records.getFirst().status()).isEqualTo(ExternalNotificationRepository.STATUS_SKIPPED);
        assertThat(externalRepo.records.getFirst().skipReason()).isEqualTo("already_resolved");

        // 3) 自操作不入队自身提醒
        enqueuer.enqueueTaskEvent(WS, PROJECT, TASK_ID, "task.assigned", OWNER, OWNER,
                ExternalNotificationRepository.URGENCY_NORMAL, "自指派", 1000L);
        assertThat(externalRepo.records).hasSize(1);
    }

    private static final class CapturingExternalRepo implements ExternalNotificationRepository {
        final List<DeliveryRecord> records = new ArrayList<>();

        @Override
        public void enqueue(NewDelivery delivery) {
            records.add(new DeliveryRecord(
                    records.size() + 1L, delivery.deliveryId(), delivery.userId(), delivery.workspaceId(),
                    delivery.projectId(), delivery.eventType(), delivery.objectId(), delivery.actorId(),
                    delivery.urgency(), delivery.titleSnapshot(), delivery.mergeKey(), STATUS_PENDING,
                    "", 0, delivery.maxAttempts(), delivery.availableAtMs(), "", delivery.occurredAtMs()
            ));
        }

        @Override
        public int cancelPendingByObject(String objectId, String skipReason, long nowMs) {
            int count = 0;
            for (int i = 0; i < records.size(); i++) {
                DeliveryRecord r = records.get(i);
                if (r.objectId().equals(objectId) && r.status() == STATUS_PENDING) {
                    records.set(i, new DeliveryRecord(
                            r.rowId(), r.deliveryId(), r.userId(), r.workspaceId(), r.projectId(),
                            r.eventType(), r.objectId(), r.actorId(), r.urgency(), r.titleSnapshot(),
                            r.mergeKey(), STATUS_SKIPPED, skipReason, r.attemptCount(), r.maxAttempts(),
                            r.availableAtMs(), r.lastError(), r.occurredAtMs()));
                    count++;
                }
            }
            return count;
        }

        @Override public int cancelPendingByObjectAndUser(String objectId, String userId, String skipReason, long nowMs) { return 0; }
        @Override public int cancelPendingByWorkspaceAndUser(String workspaceId, String userId, String skipReason, long nowMs) { return 0; }
        @Override public List<DeliveryRecord> claimDueBatch(long nowMs, int limit) { return List.of(); }
        @Override public List<DeliveryRecord> claimPendingInMergeGroup(String userId, String mergeKey, long nowMs) { return List.of(); }
        @Override public Optional<DeliveryRecord> findByDeliveryId(String deliveryId) { return Optional.empty(); }
        @Override public void markSent(List<Long> rowIds, long nowMs) {}
        @Override public void markSkipped(List<Long> rowIds, String skipReason, long nowMs) {}
        @Override public void markDeferred(List<Long> rowIds, long nextAvailableAtMs, long nowMs) {}
        @Override public void markRetry(List<Long> rowIds, int nextAttemptCount, long nextAvailableAtMs, String lastError, long nowMs) {}
        @Override public void markFailed(List<Long> rowIds, int attemptCount, String lastError, long nowMs) {}
    }
}
