package workbench.collaboration.application.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.InboxItemSource;
import workbench.collaboration.application.port.InboxItemSource.InboxSourceQuery;
import workbench.collaboration.application.port.UserNotificationQueryPort;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxActorSummary;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxCounts;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxItem;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxResponse;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxWorkspaceSummary;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 模块：跨团队全局待办收件箱应用服务 (InboxAppService)
 *
 * <p>【功能定义】
 * 聚合所有注册的 {@link InboxItemSource}（本期为 TaskInboxSource，预留 HC-241/243/245/252），
 * 以业务现态投影为唯一真相，生成全局跨 Workspace 待办列表、未筛选红点汇总角标、
 * 关联团队与发起人字典及最新跨团队通知水位游标。
 *
 * <p>【协作边界】
 * - 上游调用方：MeController。
 * - 下游依赖方：InboxItemSource 集合、IdentityRepository、UserNotificationQueryPort、Contracts。
 */
@Service
public class InboxAppService {

    private static final Set<String> VALID_BUCKETS = Set.of("action_required", "sent", "resolved");

    private final List<InboxItemSource> sources;
    private final IdentityRepository identity;
    private final UserNotificationQueryPort notifications;
    private final Contracts contracts;
    private final Clock clock;

    @Autowired
    public InboxAppService(List<InboxItemSource> sources, IdentityRepository identity,
                           UserNotificationQueryPort notifications, Contracts contracts) {
        this(sources, identity, notifications, contracts, Clock.systemUTC());
    }

    InboxAppService(List<InboxItemSource> sources, IdentityRepository identity,
                    UserNotificationQueryPort notifications, Contracts contracts, Clock clock) {
        this.sources = sources;
        this.identity = identity;
        this.notifications = notifications;
        this.contracts = contracts;
        this.clock = clock;
    }

    /**
     * 读取用户全局待办收件箱，并返回强校验通过的 InboxResponse JSON。
     */
    @Transactional(readOnly = true)
    public String getInbox(String userId, String rawBucket, String category, String workspaceId, int limit) {
        identity.findUserById(userId)
                .filter(User::enabled)
                .orElseThrow(() -> new ApiProblem(401, "AUTHENTICATION_REQUIRED"));

        String bucket = (rawBucket == null || rawBucket.isEmpty()) ? "action_required" : rawBucket;
        if (!VALID_BUCKETS.contains(bucket)) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }

        List<Workspace> userWorkspaces = identity.listWorkspacesForUser(userId);
        if (workspaceId != null && userWorkspaces.stream().noneMatch(ws -> ws.id().equals(workspaceId))) {
            throw new ApiProblem(403, "WORKSPACE_MEMBER_REQUIRED");
        }

        long nowMs = clock.millis();
        // 角标统计始终基于用户全局未筛选的现态投影，确保团队筛选不会误改左栏总红点。
        List<InboxItem> allActionRequired = collect(userId, new InboxSourceQuery("action_required", null, nowMs));
        List<InboxItem> allSent = collect(userId, new InboxSourceQuery("sent", null, nowMs));
        InboxCounts counts = new InboxCounts(
                allActionRequired.size(),
                (int) allActionRequired.stream().filter(item -> "urgent".equals(item.urgency())).count(),
                allSent.size()
        );

        List<InboxItem> rawBucketItems = switch (bucket) {
            case "action_required" -> allActionRequired;
            case "sent" -> allSent;
            case "resolved" -> collect(userId, new InboxSourceQuery("resolved", workspaceId, nowMs));
            default -> throw new ApiProblem(400, "INVALID_REQUEST");
        };

        List<InboxItem> filtered = rawBucketItems.stream()
                .filter(item -> workspaceId == null || item.workspaceId().equals(workspaceId))
                .filter(item -> category == null || item.category().equals(category))
                .sorted(comparatorFor(bucket))
                .toList();

        boolean truncated = filtered.size() > limit;
        List<InboxItem> page = truncated ? List.copyOf(filtered.subList(0, limit)) : filtered;

        List<InboxWorkspaceSummary> workspaces = userWorkspaces.stream()
                .map(ws -> new InboxWorkspaceSummary(ws.id(), ws.name(), ws.slug()))
                .toList();
        List<InboxActorSummary> actors = resolveActors(page);
        long notificationCursor = notifications.latestCursorForUser(userId);

        InboxResponse response = new InboxResponse(
                bucket, page, counts, notificationCursor, workspaces, actors, truncated);
        return contracts.encode("InboxResponse", response);
    }

    private List<InboxItem> collect(String userId, InboxSourceQuery query) {
        List<InboxItem> items = new ArrayList<>();
        for (InboxItemSource source : sources) {
            items.addAll(source.listForUser(userId, query));
        }
        return items;
    }

    private List<InboxActorSummary> resolveActors(List<InboxItem> page) {
        Map<String, Set<String>> actorWorkspaces = new LinkedHashMap<>();
        for (InboxItem item : page) {
            actorWorkspaces.computeIfAbsent(item.actorId(), ignored -> new LinkedHashSet<>()).add(item.workspaceId());
        }
        List<InboxActorSummary> summaries = new ArrayList<>(actorWorkspaces.size());
        for (var entry : actorWorkspaces.entrySet()) {
            String actorId = entry.getKey();
            Set<String> wsIds = entry.getValue();
            var user = identity.findUserById(actorId);
            String userNo = user.map(User::userNo).orElse("");
            String name = user.map(User::userName).filter(n -> !n.isBlank()).orElse("已停用成员");
            boolean active = user.filter(User::enabled).isPresent()
                    && wsIds.stream().allMatch(ws -> identity.memberExists(ws, actorId));
            summaries.add(new InboxActorSummary(actorId, userNo, name, active));
        }
        return summaries;
    }

    private static Comparator<InboxItem> comparatorFor(String bucket) {
        Comparator<InboxItem> byTimeDesc = Comparator.comparingLong(InboxItem::updatedAtMs)
                .reversed()
                .thenComparing(InboxItem::itemKey);
        if ("action_required".equals(bucket)) {
            return Comparator.comparingInt((InboxItem item) -> "urgent".equals(item.urgency()) ? 0 : 1)
                    .thenComparing(byTimeDesc);
        }
        return byTimeDesc;
    }
}
