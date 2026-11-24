package workbench.collaboration.application.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import workbench.collaboration.application.port.ExternalActor;
import workbench.collaboration.application.port.ExternalNotificationChannel;
import workbench.collaboration.application.port.ExternalNotificationChannel.DeliveryResult;
import workbench.collaboration.application.port.ExternalNotificationMessage;
import workbench.collaboration.application.port.ExternalNotificationRepository;
import workbench.collaboration.application.port.ExternalNotificationRepository.DeliveryRecord;
import workbench.collaboration.application.port.ExternalRecipient;
import workbench.collaboration.application.port.ExternalRecipientResolver;
import workbench.collaboration.application.port.InboxActionabilityChecker;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.notification.SafeNotificationBuilder;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 模块：可插拔外部通知异步出站调度引擎 (ExternalNotificationDispatcher)
 *
 * <p>【功能定义】
 * 脱离业务事务运行出站投递流水线，按如下顺序处理到期的待发送元数据：
 * <pre>
 * 抢占到期批次 (pending→sending)
 *   ──> 按 (userId, mergeKey) 合批聚拢同项目同事件burst
 *   ──> 校验用户总开关 / 订阅白名单 / 跨天免打扰顺延
 *   ──> 调用 InboxActionabilityChecker 现态复核（已办自动标 already_resolved 消噪）
 *   ──> 核对成员资格 + ExternalRecipientResolver 寻址 + SafeNotificationBuilder 强脱敏构造
 *   ──> 调用配置的 ExternalNotificationChannel（成功 / 永久失败 / 30s→120s→300s 指数退避重试）
 * </pre>
 *
 * <p>【并发与故障隔离底线】
 * 本方法严禁声明 {@code @Transactional}：外部 IM 网络超时、限流或宕机绝不能占用数据库连接或影响协作主事务。
 */
@Service
public class ExternalNotificationDispatcher {

    private static final Logger LOGGER = LoggerFactory.getLogger(ExternalNotificationDispatcher.class);
    private static final int BATCH_LIMIT = 50;
    private static final ZoneId FALLBACK_ZONE = ZoneId.of("Asia/Shanghai");

    private final ExternalNotificationRepository repository;
    private final NotificationPreferenceRepository preferences;
    private final IdentityRepository identity;
    private final ProjectRepository projects;
    private final List<InboxActionabilityChecker> checkers;
    private final ExternalRecipientResolver recipientResolver;
    private final SafeNotificationBuilder safeBuilder;
    private final Map<String, ExternalNotificationChannel> channels;
    private final WorkbenchProperties properties;
    private final Clock clock;

    private record GroupKey(String userId, String mergeKey) {}

    @Autowired
    public ExternalNotificationDispatcher(
            ExternalNotificationRepository repository,
            NotificationPreferenceRepository preferences,
            IdentityRepository identity,
            ProjectRepository projects,
            List<InboxActionabilityChecker> checkers,
            ExternalRecipientResolver recipientResolver,
            SafeNotificationBuilder safeBuilder,
            List<ExternalNotificationChannel> channelBeans,
            WorkbenchProperties properties
    ) {
        this(repository, preferences, identity, projects, checkers, recipientResolver, safeBuilder,
                channelBeans, properties, Clock.systemUTC());
    }

    ExternalNotificationDispatcher(
            ExternalNotificationRepository repository,
            NotificationPreferenceRepository preferences,
            IdentityRepository identity,
            ProjectRepository projects,
            List<InboxActionabilityChecker> checkers,
            ExternalRecipientResolver recipientResolver,
            SafeNotificationBuilder safeBuilder,
            List<ExternalNotificationChannel> channelBeans,
            WorkbenchProperties properties,
            Clock clock
    ) {
        this.repository = repository;
        this.preferences = preferences;
        this.identity = identity;
        this.projects = projects;
        this.checkers = checkers;
        this.recipientResolver = recipientResolver;
        this.safeBuilder = safeBuilder;
        this.channels = channelBeans.stream()
                .collect(Collectors.toMap(ExternalNotificationChannel::channelType, Function.identity(), (a, b) -> b));
        this.properties = properties;
        this.clock = clock;
    }

    @Scheduled(
            fixedDelayString = "${workbench.notifications.external.dispatch-interval-ms:2000}",
            initialDelayString = "${workbench.notifications.external.dispatch-interval-ms:2000}"
    )
    public void scheduledDispatch() {
        if (!"start".equalsIgnoreCase(properties.getCommand())
                || !properties.getNotifications().getExternal().isEnabled()) {
            return;
        }
        dispatchDueBatch();
    }

    /**
     * 立即执行一轮到期外部通知拉取与投递（供定时任务与单元测试直接调用），返回成功送达的卡片数。
     */
    public int dispatchDueBatch() {
        long nowMs = clock.millis();
        List<DeliveryRecord> claimed = repository.claimDueBatch(nowMs, BATCH_LIMIT);
        if (claimed.isEmpty()) {
            return 0;
        }

        Map<GroupKey, List<DeliveryRecord>> groups = new LinkedHashMap<>();
        for (DeliveryRecord record : claimed) {
            groups.computeIfAbsent(new GroupKey(record.userId(), record.mergeKey()), ignored -> new ArrayList<>())
                    .add(record);
        }

        int sentCards = 0;
        for (var entry : groups.entrySet()) {
            GroupKey key = entry.getKey();
            List<DeliveryRecord> group = entry.getValue();
            // 拉取并合并同用户、同项目同事件尚未出发的突发待投递记录，实现防抖合批。
            group.addAll(repository.claimPendingInMergeGroup(key.userId(), key.mergeKey(), nowMs));
            if (dispatchGroup(key.userId(), group, nowMs)) {
                sentCards++;
            }
        }
        return sentCards;
    }

    private boolean dispatchGroup(String userId, List<DeliveryRecord> group, long nowMs) {
        List<Long> allIds = group.stream().map(DeliveryRecord::rowId).toList();
        NotificationPreferences pref = preferences.findByUserId(userId)
                .orElseGet(NotificationPreferenceAppService::defaults);

        if (!pref.externalEnabled()) {
            repository.markSkipped(allIds, "disabled", nowMs);
            return false;
        }

        Set<String> subscribed = Set.copyOf(pref.subscribedEvents());
        List<DeliveryRecord> subscribedRecords = new ArrayList<>();
        List<Long> unsubscribedIds = new ArrayList<>();
        for (DeliveryRecord record : group) {
            if (subscribed.contains(record.eventType()) || "notification.test".equals(record.eventType())) {
                subscribedRecords.add(record);
            } else {
                unsubscribedIds.add(record.rowId());
            }
        }
        if (!unsubscribedIds.isEmpty()) {
            repository.markSkipped(unsubscribedIds, "unsubscribed", nowMs);
        }
        if (subscribedRecords.isEmpty()) {
            return false;
        }

        OptionalLong dndEndMs = computeDndEndMs(pref, nowMs);
        if (dndEndMs.isPresent()) {
            repository.markDeferred(subscribedRecords.stream().map(DeliveryRecord::rowId).toList(), dndEndMs.getAsLong(), nowMs);
            return false;
        }

        // 发送前现态复核：若等待窗口内待办已被接收/验收/取消，自动消噪不推外部 IM。
        List<DeliveryRecord> actionable = new ArrayList<>();
        List<Long> resolvedIds = new ArrayList<>();
        for (DeliveryRecord record : subscribedRecords) {
            if (isActionable(record)) {
                actionable.add(record);
            } else {
                resolvedIds.add(record.rowId());
            }
        }
        if (!resolvedIds.isEmpty()) {
            repository.markSkipped(resolvedIds, "already_resolved", nowMs);
        }
        if (actionable.isEmpty()) {
            return false;
        }

        List<Long> actionableIds = actionable.stream().map(DeliveryRecord::rowId).toList();
        Optional<User> recipientUser = identity.findUserById(userId).filter(User::enabled);
        String workspaceId = actionable.getFirst().workspaceId();
        if (recipientUser.isEmpty() || !identity.memberExists(workspaceId, userId)) {
            repository.markSkipped(actionableIds, "already_resolved", nowMs);
            return false;
        }

        Optional<ExternalRecipient> recipient = recipientResolver.resolve(recipientUser.get());
        if (recipient.isEmpty()) {
            repository.markSkipped(actionableIds, "recipient_unmapped", nowMs);
            return false;
        }

        // 选取组内最新一条事件作为主投递记录，其余记录若发送成功则标为 merged_into_batch。
        actionable.sort(Comparator.comparingLong(DeliveryRecord::occurredAtMs)
                .thenComparingLong(DeliveryRecord::rowId)
                .reversed());
        DeliveryRecord primary = actionable.getFirst();
        List<Long> secondaryIds = actionable.subList(1, actionable.size()).stream()
                .map(DeliveryRecord::rowId)
                .toList();

        int mergedCount = countDistinctObjects(actionable);
        String urgencyWire = actionable.stream().anyMatch(r -> r.urgency() == ExternalNotificationRepository.URGENCY_URGENT)
                ? "urgent"
                : "normal";

        String workspaceName = identity.findWorkspaceById(primary.workspaceId()).map(Workspace::name).orElse("");
        String projectName = primary.projectId().isEmpty()
                ? ""
                : projects.findById(primary.projectId()).map(Project::name).orElse("");
        ExternalActor actor = identity.findUserById(primary.actorId())
                .map(u -> new ExternalActor(u.id(), u.userNo(), u.userName()))
                .orElseGet(() -> new ExternalActor(primary.actorId(), "", "团队成员"));

        ExternalNotificationMessage message = safeBuilder.build(
                primary.deliveryId(),
                primary.eventType(),
                urgencyWire,
                recipient.get(),
                actor,
                primary.workspaceId(),
                workspaceName,
                primary.projectId(),
                projectName,
                primary.objectId(),
                primary.titleSnapshot(),
                mergedCount,
                primary.occurredAtMs()
        );

        String channelType = properties.getNotifications().getExternal().getChannel();
        ExternalNotificationChannel channel = channels.get(channelType);
        DeliveryResult result;
        if (channel == null) {
            LOGGER.warn("未找到已注册的外部通知通道 '{}'，本次投递将按重试退避处理", channelType);
            result = DeliveryResult.retryableFailure("channel_not_found:" + channelType);
        } else {
            try {
                result = channel.send(message);
                if (result == null) {
                    result = DeliveryResult.retryableFailure("null_delivery_result");
                }
            } catch (RuntimeException failure) {
                LOGGER.warn("外部通知通道 '{}' 执行异常，deliveryId={}", channelType, primary.deliveryId(), failure);
                result = DeliveryResult.retryableFailure(
                        failure.getMessage() == null ? failure.getClass().getSimpleName() : failure.getMessage());
            }
        }

        switch (result) {
            case DeliveryResult.Sent ignored -> {
                repository.markSent(List.of(primary.rowId()), nowMs);
                if (!secondaryIds.isEmpty()) {
                    repository.markSkipped(secondaryIds, "merged_into_batch", nowMs);
                }
                return true;
            }
            case DeliveryResult.PermanentFailure permanent -> {
                repository.markFailed(actionableIds, primary.attemptCount() + 1, permanent.reason(), nowMs);
                return false;
            }
            case DeliveryResult.RetryableFailure retryable -> {
                int nextAttempt = primary.attemptCount() + 1;
                int maxAttempts = Math.max(1, primary.maxAttempts());
                if (nextAttempt >= maxAttempts) {
                    repository.markFailed(actionableIds, nextAttempt,
                            "max_attempts_exceeded: " + retryable.reason(), nowMs);
                } else {
                    long nextAvailableAtMs = nowMs + backoffMs(nextAttempt);
                    repository.markRetry(actionableIds, nextAttempt, nextAvailableAtMs, retryable.reason(), nowMs);
                }
                return false;
            }
        }
    }

    private boolean isActionable(DeliveryRecord record) {
        if ("notification.test".equals(record.eventType())) {
            return true;
        }
        for (InboxActionabilityChecker checker : checkers) {
            if (checker.supports(record.eventType())) {
                return checker.isStillActionable(
                        record.userId(),
                        record.workspaceId(),
                        record.projectId(),
                        record.eventType(),
                        record.objectId()
                );
            }
        }
        return true;
    }

    private static int countDistinctObjects(List<DeliveryRecord> records) {
        Set<String> ids = new LinkedHashSet<>();
        for (DeliveryRecord r : records) {
            ids.add(r.objectId());
        }
        return Math.max(1, ids.size());
    }

    /**
     * 计算免打扰区间结束时间戳（支持跨午夜时段如 22:00 ~ 09:00）。
     * 若当前未处于免打扰时段返回 empty。
     */
    static OptionalLong computeDndEndMs(NotificationPreferences pref, long nowMs) {
        if (!pref.dndEnabled() || pref.dndStartMinute() == pref.dndEndMinute()) {
            return OptionalLong.empty();
        }
        ZoneId zone;
        try {
            zone = ZoneId.of(pref.dndTimezone());
        } catch (DateTimeException invalid) {
            zone = FALLBACK_ZONE;
        }
        ZonedDateTime nowZdt = Instant.ofEpochMilli(nowMs).atZone(zone);
        int currentMinute = nowZdt.getHour() * 60 + nowZdt.getMinute();
        int start = pref.dndStartMinute();
        int end = pref.dndEndMinute();
        LocalTime endTime = LocalTime.of(end / 60, end % 60);

        boolean inDnd;
        ZonedDateTime endZdt;
        if (start < end) {
            inDnd = currentMinute >= start && currentMinute < end;
            endZdt = nowZdt.toLocalDate().atTime(endTime).atZone(zone);
        } else {
            inDnd = currentMinute >= start || currentMinute < end;
            endZdt = (currentMinute >= start
                    ? nowZdt.toLocalDate().plusDays(1)
                    : nowZdt.toLocalDate())
                    .atTime(endTime)
                    .atZone(zone);
        }
        if (!inDnd) {
            return OptionalLong.empty();
        }
        long endMs = endZdt.toInstant().toEpochMilli();
        return OptionalLong.of(Math.max(endMs, nowMs + 60_000L));
    }

    /** 指数退避阶梯：第 1 次失败等 30s，第 2 次等 120s，第 3 次及以上等 300s。 */
    static long backoffMs(int failedAttemptCount) {
        if (failedAttemptCount <= 1) return 30_000L;
        if (failedAttemptCount == 2) return 120_000L;
        return 300_000L;
    }
}
