package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.UserNotificationQueryPort;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationEvent;
import workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationPage;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 模块：用户级跨团队轻量通知应用服务 (UserNotificationAppService)
 *
 * <p>【功能定义】
 * 支撑 `/api/v1/me/notifications` 翻页补读与 `/api/v1/me/notifications/stream` 跨团队实时流。
 * 在 SSE 流内为当前用户加入的每个活跃 Workspace 各自维护独立递增游标，
 * 避免不同团队写事务锁分离导致大 id 先提交、小 id 后提交时的漏读问题。
 *
 * <p>【协作边界】
 * - 上游调用方：MeController。
 * - 下游依赖方：IdentityRepository、UserNotificationQueryPort、Contracts。
 */
@Service
public class UserNotificationAppService {

    public record PollBatch(List<UserNotificationEvent> events, boolean hasMore) {}

    private final IdentityRepository identity;
    private final UserNotificationQueryPort store;
    private final Contracts contracts;

    public UserNotificationAppService(IdentityRepository identity, UserNotificationQueryPort store, Contracts contracts) {
        this.identity = identity;
        this.store = store;
        this.contracts = contracts;
    }

    /** 校验用户账号存在且处于启用状态，否则抛出 401 AUTHENTICATION_REQUIRED。 */
    @Transactional(readOnly = true)
    public void requireActiveUser(String userId) {
        identity.findUserById(userId)
                .filter(User::enabled)
                .orElseThrow(() -> new ApiProblem(401, "AUTHENTICATION_REQUIRED"));
    }

    /** 跨所有活跃团队按单调全局游标分页补读通知。 */
    @Transactional(readOnly = true)
    public UserNotificationPage page(String userId, long cursor, int limit) {
        requireActiveUser(userId);
        var rows = store.afterForUser(userId, cursor, limit + 1);
        var events = List.copyOf(rows.subList(0, Math.min(limit, rows.size())));
        long nextAfterId = events.isEmpty() ? cursor : events.getLast().id();
        return new UserNotificationPage(events, nextAfterId, rows.size() > limit);
    }

    /**
     * 跨团队 SSE 轮询：按活跃团队独立游标逐团队查询并归并排序，
     * 仅对本批实际输出到流的事件推进对应团队的游标，防止超批截断或跨团队提交乱序漏读。
     */
    @Transactional(readOnly = true)
    public PollBatch pollPerWorkspace(String userId, Map<String, Long> workspaceCursors, long initialCursor, int limit) {
        requireActiveUser(userId);
        Set<String> activeWorkspaces = identity.listWorkspacesForUser(userId).stream()
                .map(Workspace::id)
                .collect(Collectors.toSet());
        // 用户退出或被移出某团队后立即清理该团队游标，收敛权限。
        workspaceCursors.keySet().retainAll(activeWorkspaces);

        List<UserNotificationEvent> combined = new ArrayList<>();
        boolean anyWorkspaceHadMore = false;
        for (String workspaceId : activeWorkspaces) {
            long wsCursor = workspaceCursors.computeIfAbsent(workspaceId, ignored -> initialCursor);
            var rows = store.afterInWorkspace(workspaceId, userId, wsCursor, limit + 1);
            if (rows.size() > limit) {
                anyWorkspaceHadMore = true;
                combined.addAll(rows.subList(0, limit));
            } else {
                combined.addAll(rows);
            }
        }

        combined.sort(Comparator.comparingLong(UserNotificationEvent::id));
        boolean hasMore = anyWorkspaceHadMore || combined.size() > limit;
        List<UserNotificationEvent> batch = combined.size() > limit
                ? List.copyOf(combined.subList(0, limit))
                : List.copyOf(combined);
        for (UserNotificationEvent event : batch) {
            workspaceCursors.merge(event.workspaceId(), event.id(), Math::max);
        }
        return new PollBatch(batch, hasMore);
    }

    public String encodePage(UserNotificationPage page) {
        return contracts.encode("UserNotificationPage", page);
    }

    public String encodeEvent(UserNotificationEvent event) {
        return contracts.encode("UserNotificationEvent", event);
    }
}
