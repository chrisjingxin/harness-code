package workbench.collaboration.application.service;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.InboxItemSource;
import workbench.collaboration.application.port.TaskInboxRepository;
import workbench.collaboration.application.port.UserNotificationQueryPort;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.task.TaskStatus;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxItem;
import workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationEvent;
import workbench.collaboration.support.FakeStores;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * HC-246 全局待办收件箱聚合同源验证：
 * 跨团队 todo+review 聚合、doing 排除、urgent 置顶、sent/30天 resolved、
 * 离职 Project owner 代管、成员移出即时消退、越权筛选 403 与 SPI 零改动扩展。
 */
class InboxAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String ME = "11111111111141118111111111111111";
    private static final String ALICE = "22222222222242228222222222222222";
    private static final String BOB = "33333333333343338333333333333333";
    private static final String LEFT_USER = "44444444444444448444444444444444";

    private static final String WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String WS_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    private static final String PROJ_A = "10000000-0000-4000-8000-000000000001";
    private static final String PROJ_B = "10000000-0000-4000-8000-000000000002";
    private static final String PROJ_ARCHIVED = "10000000-0000-4000-8000-000000000003";

    private static final String TASK_TODO_WS_A = "20000000-0000-4000-8000-000000000001";
    private static final String TASK_DOING_WS_A = "20000000-0000-4000-8000-000000000002";
    private static final String TASK_REVIEW_WS_B = "20000000-0000-4000-8000-000000000003";
    private static final String TASK_DELEGATED_REVIEW = "20000000-0000-4000-8000-000000000004";
    private static final String TASK_SENT_DOING = "20000000-0000-4000-8000-000000000005";
    private static final String TASK_RESOLVED_RECENT = "20000000-0000-4000-8000-000000000006";
    private static final String TASK_RESOLVED_OLD = "20000000-0000-4000-8000-000000000007";

    private static final long NOW_MS = 1_800_000_000_000L;

    @Test
    void 跨团队聚合待拍板排除doing支持筛选与30天窗口() {
        var identity = new TestIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        identity.users.put(ALICE, FakeStores.user(ALICE, "80278668", "张景新", true));
        identity.users.put(BOB, FakeStores.user(BOB, "80278669", "王大林", true));
        identity.users.put(LEFT_USER, FakeStores.user(LEFT_USER, "80278670", "离职同学", false));
        identity.addWorkspace(new Workspace(WS_A, "team-a", "架构组", ME, 1, 1), ME, ALICE);
        identity.addWorkspace(new Workspace(WS_B, "team-b", "支付组", ME, 1, 1), ME, BOB);

        var repo = new InMemoryTaskInboxRepo();
        repo.rows.add(row(TASK_TODO_WS_A, WS_A, PROJ_A, "中台基座", ALICE, ProjectStatus.ACTIVE,
                "补齐网关校验", ALICE, true, ME, TaskStatus.TODO, NOW_MS - 1_000));
        repo.rows.add(row(TASK_DOING_WS_A, WS_A, PROJ_A, "中台基座", ALICE, ProjectStatus.ACTIVE,
                "进行中的日常任务", ALICE, true, ME, TaskStatus.DOING, NOW_MS - 500));
        repo.rows.add(row(TASK_REVIEW_WS_B, WS_B, PROJ_B, "支付重构", ME, ProjectStatus.ACTIVE,
                "核对清结算账单", ME, true, BOB, TaskStatus.REVIEW, NOW_MS - 5_000));
        repo.rows.add(row(TASK_DELEGATED_REVIEW, WS_B, PROJ_B, "支付重构", ME, ProjectStatus.ACTIVE,
                "代管离职同学发起的验收", LEFT_USER, false, BOB, TaskStatus.REVIEW, NOW_MS - 2_000));
        repo.rows.add(row(TASK_SENT_DOING, WS_A, PROJ_A, "中台基座", ALICE, ProjectStatus.ACTIVE,
                "我发起对方推进中", ME, true, ALICE, TaskStatus.DOING, NOW_MS - 800));
        repo.rows.add(row(TASK_RESOLVED_RECENT, WS_B, PROJ_ARCHIVED, "历史归档项目", ME, ProjectStatus.ARCHIVED,
                "20天前已完成", ALICE, true, ME, TaskStatus.DONE, NOW_MS - 20L * 86_400_000L));
        repo.rows.add(row(TASK_RESOLVED_OLD, WS_B, PROJ_ARCHIVED, "历史归档项目", ME, ProjectStatus.ARCHIVED,
                "40天前已取消", ALICE, true, ME, TaskStatus.CANCELLED, NOW_MS - 40L * 86_400_000L));

        TaskInboxSource source = new TaskInboxSource(repo);
        InboxAppService service = new InboxAppService(
                List.of(source),
                identity,
                new StubNotificationQuery(17L),
                new Contracts(),
                Clock.fixed(Instant.ofEpochMilli(NOW_MS), ZoneOffset.UTC)
        );

        // 1) 默认 action_required：包含 todo + 2 条 review（含离职代管），不含 doing；urgent 排在 normal 之前
        var actionJson = JSON.readTree(service.getInbox(ME, null, null, null, 50));
        assertThat(actionJson.path("bucket").asString()).isEqualTo("action_required");
        assertThat(actionJson.path("notificationCursor").asLong()).isEqualTo(17L);
        assertThat(actionJson.path("counts").path("actionRequired").asInt()).isEqualTo(3);
        assertThat(actionJson.path("counts").path("urgent").asInt()).isEqualTo(2);
        assertThat(actionJson.path("counts").path("sent").asInt()).isEqualTo(2);

        var items = actionJson.path("items");
        assertThat(items).hasSize(3);
        assertThat(items.get(0).path("objectId").asString()).isEqualTo(TASK_DELEGATED_REVIEW);
        assertThat(items.get(0).path("urgency").asString()).isEqualTo("urgent");
        assertThat(items.get(0).path("delegated").asBoolean()).isTrue();
        assertThat(items.get(1).path("objectId").asString()).isEqualTo(TASK_REVIEW_WS_B);
        assertThat(items.get(1).path("urgency").asString()).isEqualTo("urgent");
        assertThat(items.get(1).path("delegated").asBoolean()).isFalse();
        assertThat(items.get(2).path("objectId").asString()).isEqualTo(TASK_TODO_WS_A);
        assertThat(items.get(2).path("urgency").asString()).isEqualTo("normal");

        // 2) 按 WS_A 筛选后列表只剩 1 条，但全局 counts 仍为 3/2/2
        var filteredJson = JSON.readTree(service.getInbox(ME, "action_required", null, WS_A, 50));
        assertThat(filteredJson.path("items")).hasSize(1);
        assertThat(filteredJson.path("items").get(0).path("objectId").asString()).isEqualTo(TASK_TODO_WS_A);
        assertThat(filteredJson.path("counts").path("actionRequired").asInt()).isEqualTo(3);

        // 3) sent 桶包含我发起待对方验收和对方 doing
        var sentJson = JSON.readTree(service.getInbox(ME, "sent", null, null, 50));
        assertThat(sentJson.path("items")).hasSize(2);
        assertThat(sentJson.get("items").get(0).path("objectId").asString()).isEqualTo(TASK_SENT_DOING);
        assertThat(sentJson.get("items").get(0).path("category").asString()).isEqualTo("task_in_progress");

        // 4) resolved 桶仅保留 30 天内记录（含已归档项目）
        var resolvedJson = JSON.readTree(service.getInbox(ME, "resolved", null, null, 50));
        assertThat(resolvedJson.path("items")).hasSize(1);
        assertThat(resolvedJson.path("items").get(0).path("objectId").asString()).isEqualTo(TASK_RESOLVED_RECENT);

        // 5) 成员被移出项目后（从可见查询消失）条目即时消退，且现态复核返回 false
        assertThat(source.isStillActionable(ME, WS_B, PROJ_B, "task.review_requested", TASK_DELEGATED_REVIEW)).isTrue();
        assertThat(source.isStillActionable(ME, WS_A, PROJ_A, "task.assigned", TASK_TODO_WS_A)).isTrue();
        assertThat(source.isStillActionable(ME, WS_A, PROJ_A, "task.assigned", TASK_DOING_WS_A)).isFalse();
        repo.rows.removeIf(r -> r.taskId().equals(TASK_TODO_WS_A));
        var afterRemovalJson = JSON.readTree(service.getInbox(ME, "action_required", null, null, 50));
        assertThat(afterRemovalJson.path("counts").path("actionRequired").asInt()).isEqualTo(2);
        assertThat(source.isStillActionable(ME, WS_A, PROJ_A, "task.assigned", TASK_TODO_WS_A)).isFalse();

        // 6) 传入非成员团队筛选返回 403 WORKSPACE_MEMBER_REQUIRED
        assertThatThrownBy(() -> service.getInbox(ME, "action_required", null, WS_OTHER, 50))
                .isInstanceOf(ApiProblem.class)
                .extracting("status", "code")
                .containsExactly(403, "WORKSPACE_MEMBER_REQUIRED");
    }

    @Test
    void 支持零改动注入扩展InboxItemSource并统一聚合排序() {
        var identity = new TestIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        identity.users.put(ALICE, FakeStores.user(ALICE, "80278668", "张景新", true));
        identity.addWorkspace(new Workspace(WS_A, "team-a", "架构组", ME, 1, 1), ME, ALICE);

        InboxItemSource customKnowledgeSource = new InboxItemSource() {
            @Override
            public String sourceType() { return "knowledge_proposal"; }

            @Override
            public List<InboxItem> listForUser(String userId, InboxSourceQuery query) {
                if (!"action_required".equals(query.bucket())) return List.of();
                return List.of(new InboxItem(
                        "knowledge_proposal:30000000-0000-4000-8000-000000000001",
                        "knowledge_proposal",
                        "knowledge_review",
                        "urgent",
                        WS_A,
                        null,
                        "",
                        "30000000-0000-4000-8000-000000000001",
                        "待审核团队踩坑：连接池配置规范",
                        "pending",
                        ALICE,
                        false,
                        NOW_MS
                ));
            }
        };

        var repo = new InMemoryTaskInboxRepo();
        repo.rows.add(row(TASK_TODO_WS_A, WS_A, PROJ_A, "中台基座", ALICE, ProjectStatus.ACTIVE,
                "普通任务", ALICE, true, ME, TaskStatus.TODO, NOW_MS + 1_000));

        InboxAppService service = new InboxAppService(
                List.of(new TaskInboxSource(repo), customKnowledgeSource),
                identity,
                new StubNotificationQuery(0L),
                new Contracts(),
                Clock.fixed(Instant.ofEpochMilli(NOW_MS), ZoneOffset.UTC)
        );

        var json = JSON.readTree(service.getInbox(ME, "action_required", null, null, 50));
        assertThat(json.path("counts").path("actionRequired").asInt()).isEqualTo(2);
        assertThat(json.path("counts").path("urgent").asInt()).isEqualTo(1);
        assertThat(json.path("items").get(0).path("sourceType").asString()).isEqualTo("knowledge_proposal");
        assertThat(json.path("items").get(0).path("projectId").isNull()).isTrue();
        assertThat(json.path("items").get(1).path("objectId").asString()).isEqualTo(TASK_TODO_WS_A);
    }

    private static TaskInboxRepository.InboxTaskRow row(
            String taskId, String wsId, String projectId, String projectName, String ownerId, ProjectStatus projectStatus,
            String title, String creatorId, boolean creatorActive, String assigneeId, TaskStatus taskStatus, long updatedAtMs) {
        return new TaskInboxRepository.InboxTaskRow(
                taskId, wsId, projectId, projectName, ownerId, projectStatus.db(),
                title, creatorId, creatorActive, assigneeId, taskStatus.code, updatedAtMs);
    }

    private static final class TestIdentity implements workbench.collaboration.domain.identity.IdentityRepository {
        final Map<String, User> users = new java.util.HashMap<>();
        final List<String> members = new ArrayList<>();
        private final List<Workspace> workspaceList = new ArrayList<>();

        void addWorkspace(Workspace workspace, String... memberIds) {
            workspaceList.add(workspace);
            for (String memberId : memberIds) {
                members.add(workspace.id() + ":" + memberId);
            }
        }

        @Override public Optional<User> findUserById(String id) { return Optional.ofNullable(users.get(id)); }
        @Override public Optional<User> findUserByUserNo(String userNo) { return Optional.empty(); }
        @Override public void insertUser(User user) { users.put(user.id(), user); }
        @Override public Optional<workbench.collaboration.domain.identity.Org> findOrgById(String orgId) { return Optional.empty(); }
        @Override public void insertOrg(workbench.collaboration.domain.identity.Org org) {}
        @Override public boolean userOrgExists(String userId, String orgId) { return false; }
        @Override public void insertUserOrg(workbench.collaboration.domain.identity.UserOrg userOrg) {}
        @Override public Optional<Workspace> findWorkspaceById(String id) { return Optional.empty(); }
        @Override public Optional<Workspace> findWorkspaceBySlug(String slug) { return Optional.empty(); }
        @Override public void insertWorkspace(Workspace workspace) {}
        @Override public boolean memberExists(String workspaceId, String userId) { return members.contains(workspaceId + ":" + userId); }
        @Override public void insertMember(workbench.collaboration.domain.identity.WorkspaceMember member) {}
        @Override public void lockWorkspace(String workspaceId) {}
        @Override public Optional<workbench.collaboration.domain.identity.WorkspaceMember> findMember(String workspaceId, String userId) { return Optional.empty(); }
        @Override public List<User> listDemoUsers() { return List.of(); }
        @Override public List<Workspace> listWorkspacesForUser(String userId) {
            return workspaceList.stream().filter(ws -> memberExists(ws.id(), userId)).toList();
        }
        @Override public List<User> listMembers(String workspaceId) { return List.of(); }
    }

    private static final class InMemoryTaskInboxRepo implements TaskInboxRepository {
        final List<InboxTaskRow> rows = new ArrayList<>();

        @Override
        public List<InboxTaskRow> listVisibleTasksForUser(String userId, String workspaceIdFilter) {
            return rows.stream()
                    .filter(r -> workspaceIdFilter == null || r.workspaceId().equals(workspaceIdFilter))
                    .toList();
        }

        @Override
        public Optional<InboxTaskRow> findVisibleTaskForUser(String userId, String workspaceId, String projectId, String taskId) {
            return rows.stream()
                    .filter(r -> r.workspaceId().equals(workspaceId)
                            && r.projectId().equals(projectId)
                            && r.taskId().equals(taskId))
                    .findFirst();
        }
    }

    private record StubNotificationQuery(long cursor) implements UserNotificationQueryPort {
        @Override public List<UserNotificationEvent> afterForUser(String userId, long c, int limit) { return List.of(); }
        @Override public List<UserNotificationEvent> afterInWorkspace(String wsId, String userId, long c, int limit) { return List.of(); }
        @Override public long latestCursorForUser(String userId) { return cursor; }
    }
}
