package workbench.collaboration.application.service;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import workbench.collaboration.application.port.UserNotificationQueryPort;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.messaging.NotificationSignal;
import workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationEvent;
import workbench.collaboration.interfaces.filter.BoundaryFilter;
import workbench.collaboration.interfaces.http.RouteCatalog;
import workbench.collaboration.interfaces.rest.MeController;
import workbench.collaboration.support.FakeStores;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 验证跨团队用户级通知分页、独立 Workspace 游标防漏读与 MeController 边界路由校验。
 */
class UserNotificationStreamTest {

    private static final String ME = "11111111111141118111111111111111";
    private static final String WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String OBJ_1 = "10000000-0000-4000-8000-000000000001";
    private static final String OBJ_2 = "10000000-0000-4000-8000-000000000002";
    private static final String OBJ_3 = "10000000-0000-4000-8000-000000000003";
    private static final String EVT_ID = "99999999-9999-4999-8999-999999999999";

    @Test
    void 跨团队乱序提交不漏读且按批截断不跳过同团队后续事件() {
        var identity = new TestIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        var wsA = new Workspace(WS_A, "team-a", "团队A", ME, 1, 1);
        var wsB = new Workspace(WS_B, "team-b", "团队B", ME, 1, 1);
        identity.workspaces.add(wsA);
        identity.workspaces.add(wsB);
        identity.addMember(WS_A, ME);
        identity.addMember(WS_B, ME);

        var store = new InMemoryNotificationQuery();
        // 模拟场景 1：团队 A 先提交了大 id=102，团队 B 尚未提交 id=101
        store.events.add(new UserNotificationEvent(102L, EVT_ID, WS_A, "task.assigned", OBJ_2, OBJ_1, 2000L));

        UserNotificationAppService service = new UserNotificationAppService(identity, store, new Contracts());
        Map<String, Long> wsCursors = new HashMap<>();

        var batch1 = service.pollPerWorkspace(ME, wsCursors, 100L, 2);
        assertThat(batch1.events()).extracting(UserNotificationEvent::id).containsExactly(102L);
        assertThat(batch1.hasMore()).isFalse();
        assertThat(wsCursors.get(WS_A)).isEqualTo(102L);
        assertThat(wsCursors.get(WS_B)).isEqualTo(100L);

        // 团队 B 的旧编号 id=101 晚提交（同时带入 id=103、团队 A 的 id=104），且测试 limit=2 截断
        store.events.add(new UserNotificationEvent(101L, EVT_ID, WS_B, "task.assigned", OBJ_1, OBJ_1, 1000L));
        store.events.add(new UserNotificationEvent(103L, EVT_ID, WS_B, "task.changed", OBJ_3, OBJ_1, 3000L));
        store.events.add(new UserNotificationEvent(104L, EVT_ID, WS_A, "task.changed", OBJ_2, OBJ_1, 4000L));

        var batch2 = service.pollPerWorkspace(ME, wsCursors, 100L, 2);
        assertThat(batch2.events()).extracting(UserNotificationEvent::id).containsExactly(101L, 103L);
        assertThat(batch2.hasMore()).isTrue();
        assertThat(wsCursors.get(WS_B)).isEqualTo(103L);
        assertThat(wsCursors.get(WS_A)).isEqualTo(102L);

        var batch3 = service.pollPerWorkspace(ME, wsCursors, 100L, 2);
        assertThat(batch3.events()).extracting(UserNotificationEvent::id).containsExactly(104L);
        assertThat(batch3.hasMore()).isFalse();

        // 退出团队 B 后，旧游标自动收敛清理
        identity.members.remove(WS_B + ":" + ME);
        service.pollPerWorkspace(ME, wsCursors, 100L, 2);
        assertThat(wsCursors).containsOnlyKeys(WS_A);
    }

    @Test
    void 分页读取返回正确游标与hasMore() {
        var identity = new TestIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        var store = new InMemoryNotificationQuery();
        store.events.add(new UserNotificationEvent(11L, EVT_ID, WS_A, "task.assigned", OBJ_1, OBJ_1, 1000L));
        store.events.add(new UserNotificationEvent(12L, EVT_ID, WS_B, "task.changed", OBJ_2, OBJ_1, 2000L));

        UserNotificationAppService service = new UserNotificationAppService(identity, store, new Contracts());
        var page1 = service.page(ME, 10L, 1);
        assertThat(page1.events()).extracting(UserNotificationEvent::id).containsExactly(11L);
        assertThat(page1.nextAfterId()).isEqualTo(11L);
        assertThat(page1.hasMore()).isTrue();

        var page2 = service.page(ME, 11L, 5);
        assertThat(page2.events()).extracting(UserNotificationEvent::id).containsExactly(12L);
        assertThat(page2.hasMore()).isFalse();
    }

    @Test
    void me端点在BoundaryFilter下接受合法参数并拦截非法Limit或Bucket() throws Exception {
        String origin = "http://127.0.0.1:18084";
        Contracts contracts = new Contracts();
        InboxAppService inbox = mock(InboxAppService.class);
        UserNotificationAppService userNotifications = mock(UserNotificationAppService.class);
        NotificationPreferenceAppService prefs = mock(NotificationPreferenceAppService.class);

        when(inbox.getInbox(ME, "action_required", null, WS_A, 150)).thenReturn("{\"bucket\":\"action_required\"}");
        when(prefs.encode(NotificationPreferenceAppService.defaults())).thenReturn("{\"externalEnabled\":true}");
        when(prefs.get(ME)).thenReturn(NotificationPreferenceAppService.defaults());
        when(prefs.update(ME, "{}")).thenReturn("{\"externalEnabled\":true}");

        MockMvc mvc = MockMvcBuilders.standaloneSetup(new MeController(inbox, userNotifications, prefs, new NotificationSignal()))
                .addFilters(new BoundaryFilter(contracts, new RouteCatalog(), origin, "127.0.0.1:18084"))
                .build();

        var auth = new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(ME, null, List.of());
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(auth);
        try {
            mvc.perform(get("/api/v1/me/inbox?bucket=action_required&workspaceId=" + WS_A + "&limit=150")
                            .header("Host", "127.0.0.1:18084")
                            .header("Origin", origin)
                            .header("X-Workbench-Protocol-Version", "1"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.returnCode").value("SUC0000"));

            mvc.perform(get("/api/v1/me/inbox?bucket=unknown")
                            .header("Host", "127.0.0.1:18084")
                            .header("Origin", origin)
                            .header("X-Workbench-Protocol-Version", "1"))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.body.code").value("INVALID_REQUEST"));

            mvc.perform(get("/api/v1/me/inbox?limit=201")
                            .header("Host", "127.0.0.1:18084")
                            .header("Origin", origin)
                            .header("X-Workbench-Protocol-Version", "1"))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.body.code").value("INVALID_REQUEST"));

            mvc.perform(get("/api/v1/me/notification-preferences")
                            .header("Host", "127.0.0.1:18084")
                            .header("Origin", origin)
                            .header("X-Workbench-Protocol-Version", "1"))
                    .andExpect(status().isOk());

            mvc.perform(put("/api/v1/me/notification-preferences")
                            .header("Host", "127.0.0.1:18084")
                            .header("Origin", origin)
                            .header("X-Workbench-Protocol-Version", "1")
                            .contentType("application/json")
                            .content("{}"))
                    .andExpect(status().isOk());
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
        }
    }

    @Test
    void workspaceMemberChanged事件通过契约校验且MeController流跳过毒丸事件继续推送合法通知() throws Exception {
        String origin = "http://127.0.0.1:18084";
        Contracts contracts = new Contracts();
        var identity = new TestIdentity();
        identity.users.put(ME, FakeStores.user(ME, "80278667", "沈北辰", true));
        identity.workspaces.add(new Workspace(WS_A, "team-a", "团队A", ME, 1, 1));
        identity.addMember(WS_A, ME);

        var store = new InMemoryNotificationQuery();
        // 毒丸事件（type 非法、不合契约）排在前面，合法任务指派与成员变更事件排在后面
        var poisonEvent = new UserNotificationEvent(101L, EVT_ID, WS_A, "invalid.poison_event", OBJ_1, OBJ_1, 1000L);
        var validMemberChanged = new UserNotificationEvent(102L, EVT_ID, WS_A, "workspace.member_changed", ME, null, 2000L);
        var validTaskAssigned = new UserNotificationEvent(103L, EVT_ID, WS_A, "task.assigned", OBJ_2, OBJ_1, 3000L);
        store.events.add(poisonEvent);
        store.events.add(validMemberChanged);
        store.events.add(validTaskAssigned);

        UserNotificationAppService userNotifications = new UserNotificationAppService(identity, store, contracts);
        assertThat(userNotifications.encodeEvent(validMemberChanged)).contains("\"workspace.member_changed\"");
        assertThat(userNotifications.encodePage(new workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationPage(
                List.of(validMemberChanged), 102L, false))).contains("\"nextAfterId\":102");

        InboxAppService inbox = mock(InboxAppService.class);
        NotificationPreferenceAppService prefs = mock(NotificationPreferenceAppService.class);
        MockHttpSession session = new MockHttpSession();
        NotificationSignal stopAfterFirstPoll = new NotificationSignal() {
            @Override
            public void await(long seen) {
                session.invalidate();
            }
        };

        MockMvc mvc = MockMvcBuilders.standaloneSetup(new MeController(inbox, userNotifications, prefs, stopAfterFirstPoll))
                .addFilters(new BoundaryFilter(contracts, new RouteCatalog(), origin, "127.0.0.1:18084"))
                .build();

        var auth = new UsernamePasswordAuthenticationToken(ME, null, List.of());
        var context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(auth);
        SecurityContextHolder.setContext(context);
        session.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY, context);

        try {
            MvcResult pending = mvc.perform(get("/api/v1/me/notifications/stream?afterId=100")
                            .session(session)
                            .header("Host", "127.0.0.1:18084")
                            .header("Origin", origin)
                            .header("X-Workbench-Protocol-Version", "1"))
                    .andExpect(request().asyncStarted())
                    .andReturn();
            pending.getAsyncResult(5000);
            String sseBody = mvc.perform(asyncDispatch(pending))
                    .andExpect(status().isOk())
                    .andReturn()
                    .getResponse()
                    .getContentAsString();
            assertThat(sseBody).doesNotContain("invalid.poison_event");
            assertThat(sseBody).contains("event:workspace.member_changed");
            assertThat(sseBody).contains("event:task.assigned");
            assertThat(sseBody).contains(OBJ_2);
        } finally {
            SecurityContextHolder.clearContext();
        }
    }

    private static final class TestIdentity implements workbench.collaboration.domain.identity.IdentityRepository {
        final Map<String, workbench.collaboration.domain.identity.User> users = new HashMap<>();
        final List<String> members = new ArrayList<>();
        final List<Workspace> workspaces = new ArrayList<>();

        void addMember(String workspaceId, String userId) {
            members.add(workspaceId + ":" + userId);
        }

        @Override public java.util.Optional<workbench.collaboration.domain.identity.User> findUserById(String id) { return java.util.Optional.ofNullable(users.get(id)); }
        @Override public java.util.Optional<workbench.collaboration.domain.identity.User> findUserByUserNo(String userNo) { return java.util.Optional.empty(); }
        @Override public void insertUser(workbench.collaboration.domain.identity.User user) { users.put(user.id(), user); }
        @Override public java.util.Optional<workbench.collaboration.domain.identity.Org> findOrgById(String orgId) { return java.util.Optional.empty(); }
        @Override public void insertOrg(workbench.collaboration.domain.identity.Org org) {}
        @Override public boolean userOrgExists(String userId, String orgId) { return false; }
        @Override public void insertUserOrg(workbench.collaboration.domain.identity.UserOrg userOrg) {}
        @Override public java.util.Optional<Workspace> findWorkspaceById(String id) { return java.util.Optional.empty(); }
        @Override public java.util.Optional<Workspace> findWorkspaceBySlug(String slug) { return java.util.Optional.empty(); }
        @Override public void insertWorkspace(Workspace workspace) {}
        @Override public boolean memberExists(String workspaceId, String userId) { return members.contains(workspaceId + ":" + userId); }
        @Override public void insertMember(workbench.collaboration.domain.identity.WorkspaceMember member) {}
        @Override public void lockWorkspace(String workspaceId) {}
        @Override public java.util.Optional<workbench.collaboration.domain.identity.WorkspaceMember> findMember(String workspaceId, String userId) { return java.util.Optional.empty(); }
        @Override public List<workbench.collaboration.domain.identity.User> listDemoUsers() { return List.of(); }
        @Override public List<Workspace> listWorkspacesForUser(String userId) {
            return workspaces.stream().filter(w -> memberExists(w.id(), userId)).toList();
        }
        @Override public List<workbench.collaboration.domain.identity.User> listMembers(String workspaceId) { return List.of(); }
    }

    private static final class InMemoryNotificationQuery implements UserNotificationQueryPort {
        final List<UserNotificationEvent> events = new ArrayList<>();

        @Override
        public List<UserNotificationEvent> afterForUser(String userId, long cursor, int limit) {
            return events.stream()
                    .filter(e -> e.id() > cursor)
                    .sorted(java.util.Comparator.comparingLong(UserNotificationEvent::id))
                    .limit(limit)
                    .toList();
        }

        @Override
        public List<UserNotificationEvent> afterInWorkspace(String workspaceId, String userId, long cursor, int limit) {
            return events.stream()
                    .filter(e -> e.workspaceId().equals(workspaceId) && e.id() > cursor)
                    .sorted(java.util.Comparator.comparingLong(UserNotificationEvent::id))
                    .limit(limit)
                    .toList();
        }

        @Override
        public long latestCursorForUser(String userId) {
            return events.stream().mapToLong(UserNotificationEvent::id).max().orElse(0L);
        }
    }
}
