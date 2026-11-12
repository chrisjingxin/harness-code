package workbench.collaboration.application.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.EventEncoder;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.application.port.RealtimeBroadcastPort;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.EventWindowPort;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.device.SharedProject;
import workbench.collaboration.domain.execution.ExecutionAuthDomainService;
import workbench.collaboration.domain.execution.ExecutionState;
import workbench.collaboration.domain.execution.ExecutionStateMachine;
import workbench.collaboration.domain.execution.ExecutionStatePort;
import workbench.collaboration.domain.execution.SequenceNumbers;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.infrastructure.messaging.ConversationEventHub;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ConversationDtos;
import workbench.collaboration.interfaces.dto.ExecutionDtos;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 模块：协作会话应用编排服务 (ConversationAppService)
 *
 * <p>【功能定义】
 * 本模块为桌面多人多端协作的核心编排枢纽。负责用户会话创建、提问发送、任务取消、
 * 事件历史补齐，以及接收 Electron 本机 Daemon 推送的定稿 Agent 消息与执行状态流转。
 *
 * <p>【核心并发与事务不变量 (Invariants)】
 * - 绝不跨网络持锁：数据库短事务仅用于原子锁定并推进 wb_conversation 行的 nextSequence 水位；
 *   严禁在持有数据库事务或行锁期间发起 Redis、Kafka、SSE 广播或 WebSocket 等网络 I/O。
 * - 存算分离：TDSQL 只保留会话控制头（wb_conversation）；定稿 Message 写入 Redis 热滑窗与 ES 7.6.0，
 *   彻底根除流式 Token 碎片入库与单表千万行级写放大。
 *
 * <p>【协作业务时序线框图】
 * <pre>
 * 1. 用户提问主流程 (sendInput)：
 *   客户端 POST /input ──> 幂等校验 (IdempotentCalls)
 *                             │
 *                             ▼
 *   [短事务 lockById] ──> 锁定会话行，占用连续序号 (inputSeq, committedSeq)，推进 nextSequence
 *                             │
 *                             ▼ (事务提交释放行锁)
 *   [存算分离多路分发] ──> 保存 User Message 至 Redis/ES
 *                      ──> 保存 ExecutionState (queued) 至 Redis
 *                      ──> 追加本地 EventWindow 热滑窗
 *                      ──> 异步广播 SSE 会话事件 (wb.conversation.events)
 *                      ──> 投递 Kafka 搜索索引主题
 *                      ──> 下发 execution.start 指令至 Daemon WebSocket
 *
 * 2. 端侧定稿上报流程 (recordDaemonPush)：
 *   Electron Daemon ──> 携带 runnerSequence 与指纹推送定稿 Agent 消息 / 终态变更
 *                             │
 *                             ▼
 *   [来源去重] ─────────> 校验指纹一致性，防重放与篡改
 *                             │
 *                             ▼
 *   [短事务 lockById] ──> 锁定会话行，按消息与状态跨度推进 nextSequence
 *                             │
 *                             ▼ (事务提交释放行锁)
 *   [广播与归档] ───────> 保存 Agent Message 至 Redis/ES
 *                      ──> 更新 ExecutionState 至 Redis
 *                      ──> 追加热滑窗并广播跨节点 SSE
 *                      ──> 返回 ACK 回执
 * </pre>
 */
@Service
public class ConversationAppService {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final IdentityAppService identity;
    private final ConversationRepository conversations;
    private final DeviceRepository devices;
    private final IdempotencyPort idempotency;
    private final MessageStorePort messages;
    private final EventWindowPort events;
    private final ExecutionStatePort executions;
    private final EventEncoder encoder;
    private final RealtimeBroadcastPort bus;
    private final ConversationEventHub hub;
    private final ExecutionAppService dispatch;
    private final Contracts contracts;
    private final TransactionTemplate transaction;

    public ConversationAppService(
            IdentityAppService identity,
            ConversationRepository conversations,
            DeviceRepository devices,
            IdempotencyPort idempotency,
            MessageStorePort messages,
            EventWindowPort events,
            ExecutionStatePort executions,
            EventEncoder encoder,
            RealtimeBroadcastPort bus,
            ConversationEventHub hub,
            ExecutionAppService dispatch,
            Contracts contracts
    ) {
        this(identity, conversations, devices, idempotency, messages, events, executions, encoder, bus, hub, dispatch, contracts, null);
    }

    @Autowired
    public ConversationAppService(
            IdentityAppService identity,
            ConversationRepository conversations,
            DeviceRepository devices,
            IdempotencyPort idempotency,
            MessageStorePort messages,
            EventWindowPort events,
            ExecutionStatePort executions,
            EventEncoder encoder,
            RealtimeBroadcastPort bus,
            ConversationEventHub hub,
            ExecutionAppService dispatch,
            Contracts contracts,
            PlatformTransactionManager transactionManager
    ) {
        this.identity = identity;
        this.conversations = conversations;
        this.devices = devices;
        this.idempotency = idempotency;
        this.messages = messages;
        this.events = events;
        this.executions = executions;
        this.encoder = encoder;
        this.bus = bus;
        this.hub = hub;
        this.dispatch = dispatch;
        this.contracts = contracts;
        this.transaction = transactionManager == null ? null : new TransactionTemplate(transactionManager);
    }

    /**
     * 创建一个全新的协作会话。
     *
     * <p>【逻辑链路】
     * 输入校验 → 目标设备与项目可用性准入 → 插入会话控制头（初始序号设为 2） → 广播创建事件 → 异步索引
     *
     * @param userId 创建用户标识
     * @param workspaceId 挂载工作区标识
     * @param rawBody 请求原始报文
     * @return 会话创建结果 JSON
     */
    public String create(String userId, String workspaceId, String rawBody) {
        User user = identity.requireUser(userId);
        identity.requireMember(workspaceId, userId);
        ConversationDtos.CreateConversationRequest request = contracts.decode(
                "CreateConversationRequest",
                rawBody,
                ConversationDtos.CreateConversationRequest.class
        );
        String fingerprint = IdempotentCalls.fingerprint(rawBody);

        return IdempotentCalls.run(idempotency, workspaceId, userId, "conversation.create", request.requestId(), fingerprint, () -> {
            requireTarget(workspaceId, request.deviceId(), request.projectId(), request.agentConfigId());
            long now = System.currentTimeMillis();
            String id = UUID.randomUUID().toString();
            // nextSequence 初始化为 2，因为第 1 号序号分配给 conversation.created 事件本身
            Conversation conversation = new Conversation(
                    id,
                    workspaceId,
                    request.title(),
                    user.id(),
                    user.id(),
                    request.deviceId(),
                    request.projectId(),
                    request.agentConfigId(),
                    2,
                    null,
                    null,
                    now,
                    now
            );
            inShortTransaction(() -> {
                conversations.insert(conversation);
                return null;
            });
            String event = encoder.conversationCreated(conversation, 1, now);
            emit(id, List.of(event));
            var response = new ConversationDtos.CreateConversationResponse(summary(conversation), "1");
            bus.publishSearchIndex(workspaceId, JSON.writeValueAsString(response.conversation()));
            return contracts.encode("CreateConversationResponse", response);
        });
    }

    /**
     * 发送用户提问输入并派发执行。
     *
     * <p>【逻辑链路】
     * 输入与权限校验 → 锁定会话头分配 2 个序号（输入消息号 + 状态变更号） →
     * 保存用户定稿消息 → 保存排队执行状态 → 广播 SSE 实时事件 → 投递指令到设备 WebSocket
     *
     * @param userId 提问用户标识
     * @param workspaceId 所属工作区标识
     * @param conversationId 目标会话标识
     * @param rawBody 提问请求原始报文
     * @return 输入已保存响应 JSON
     */
    public String sendInput(String userId, String workspaceId, String conversationId, String rawBody) {
        User user = identity.requireUser(userId);
        identity.requireMember(workspaceId, userId);
        ConversationDtos.SendInputRequest request = contracts.decode(
                "SendInputRequest",
                rawBody,
                ConversationDtos.SendInputRequest.class
        );
        // 指纹带上会话 ID，避免同一个 requestId 在不同会话间错误重放
        String fingerprint = IdempotentCalls.fingerprint(conversationId, rawBody);

        return IdempotentCalls.run(idempotency, workspaceId, userId, "input.send", request.requestId(), fingerprint, () -> {
            Conversation conversation = requireConversation(workspaceId, conversationId);
            SharedProject project = requireTarget(workspaceId, conversation.deviceId(), conversation.projectId(), conversation.agentConfigId());
            long now = System.currentTimeMillis();
            String inputId = UUID.randomUUID().toString();
            String executionId = UUID.randomUUID().toString();
            String messageId = UUID.randomUUID().toString();

            record Allocated(Conversation locked, long inputSequence, long committed) {}

            // 短事务：行级悲观锁保障单调递增序号严格连续，杜绝并发产生相同 sequence
            Allocated allocated = inShortTransaction(() -> {
                Conversation locked = conversations.lockById(conversationId)
                        .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
                long inputSeq = locked.nextSequence();
                long committedSeq = inputSeq + 1;
                long next = SequenceNumbers.advance(locked.nextSequence(), 2);
                conversations.update(new Conversation(
                        locked.id(),
                        locked.workspaceId(),
                        locked.title(),
                        locked.createdByUserId(),
                        user.id(),
                        locked.deviceId(),
                        locked.projectId(),
                        locked.agentConfigId(),
                        next,
                        locked.nativeSessionId(),
                        executionId,
                        locked.createdAtMs(),
                        now
                ));
                return new Allocated(locked, inputSeq, committedSeq);
            });

            var start = dispatch.createStart(
                    allocated.locked(),
                    executionId,
                    inputId,
                    allocated.inputSequence(),
                    user.id(),
                    now,
                    request.text(),
                    project.shareVersion()
            );
            Message message = new Message(
                    messageId,
                    workspaceId,
                    conversationId,
                    executionId,
                    "user",
                    user.id(),
                    user.username(),
                    user.displayName(),
                    null,
                    allocated.inputSequence(),
                    request.text(),
                    "completed",
                    now
            );
            ExecutionState state = new ExecutionState(
                    executionId,
                    conversationId,
                    inputId,
                    allocated.inputSequence(),
                    user.id(),
                    "queued",
                    "queued",
                    "none",
                    null,
                    now,
                    now,
                    start.payload().bodySha256()
            );

            // 事务外写入存算分离存储
            messages.save(message);
            executions.save(state);

            String messageEvent = encoder.messageCreated(message, workspaceId, allocated.inputSequence(), now);
            String executionEvent = encoder.executionChanged(workspaceId, state, allocated.committed(), now);
            emit(conversationId, List.of(messageEvent, executionEvent));

            // 异步解耦：发布 ES 检索与下发 Daemon 物理连接
            bus.publishSearchIndex(workspaceId, JSON.writeValueAsString(message));
            bus.publishDaemonCommand(conversation.deviceId(), dispatch.json(start));

            return contracts.encode("InputSavedResponse", new ConversationDtos.InputSavedResponse(
                    conversationId,
                    inputId,
                    executionId,
                    Long.toString(allocated.inputSequence()),
                    Long.toString(allocated.committed()),
                    TimeCodec.utc(now)
            ));
        });
    }

    /**
     * 取消正在进行的任务执行。
     *
     * <p>【状态机与幂等保护 (Why)】
     * - 若该执行已是终态或已处于取消流程，直接幂等返回当前状态，不重复推进序号；
     * - 仅允许从 "queued" 状态原子跃迁为 "cancelled"；
     * - 取消成功后释放会话的 activeExecutionId 占用。
     *
     * @param userId 操作用户标识
     * @param workspaceId 工作区标识
     * @param conversationId 会话标识
     * @param executionId 目标执行标识
     * @param rawBody 请求报文
     * @return 取消响应 JSON
     */
    public String cancel(String userId, String workspaceId, String conversationId, String executionId, String rawBody) {
        identity.requireMember(workspaceId, userId);
        ConversationDtos.CancelExecutionRequest request = contracts.decode(
                "CancelExecutionRequest",
                rawBody,
                ConversationDtos.CancelExecutionRequest.class
        );
        String fingerprint = IdempotentCalls.fingerprint(conversationId, executionId, rawBody);

        return IdempotentCalls.run(idempotency, workspaceId, userId, "execution.cancel", request.requestId(), fingerprint, () -> {
            requireConversation(workspaceId, conversationId);
            ExecutionState state = executions.find(executionId)
                    .filter(found -> found.conversationId().equals(conversationId))
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
            long now = System.currentTimeMillis();

            record Cancelled(boolean alreadyDone, long sequence) {}

            Cancelled result = inShortTransaction(() -> {
                Conversation locked = conversations.lockById(conversationId)
                        .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
                long high = locked.nextSequence() - 1;
                // 若已处于终态或已有取消决议，直接幂等返回
                if (ExecutionStateMachine.terminal(state.state()) || !"none".equals(state.cancelState())) {
                    return new Cancelled(true, high);
                }
                if (!ExecutionStateMachine.legal(state.state(), "cancelled") || !"queued".equals(state.state())) {
                    throw new ApiProblem(409, "EXECUTION_STATE_CONFLICT");
                }
                long sequence = locked.nextSequence();
                conversations.update(new Conversation(
                        locked.id(),
                        locked.workspaceId(),
                        locked.title(),
                        locked.createdByUserId(),
                        locked.currentUserId(),
                        locked.deviceId(),
                        locked.projectId(),
                        locked.agentConfigId(),
                        SequenceNumbers.advance(sequence, 1),
                        locked.nativeSessionId(),
                        null,
                        locked.createdAtMs(),
                        now
                ));
                return new Cancelled(false, sequence);
            });

            if (result.alreadyDone()) {
                return contracts.encode("CancelExecutionResponse", new ConversationDtos.CancelExecutionResponse(
                        executionId,
                        state.cancelState(),
                        state.state(),
                        Long.toString(result.sequence())
                ));
            }

            ExecutionState cancelled = new ExecutionState(
                    state.executionId(),
                    state.conversationId(),
                    state.inputId(),
                    state.inputSequence(),
                    state.initiatedByUserId(),
                    "cancelled",
                    state.lastConfirmedState(),
                    "resolved",
                    "CANCELLED_BEFORE_DISPATCH",
                    state.createdAtMs(),
                    now,
                    state.commandFingerprint()
            );
            executions.save(cancelled);
            emit(conversationId, List.of(encoder.executionChanged(workspaceId, cancelled, result.sequence(), now)));

            return contracts.encode("CancelExecutionResponse", new ConversationDtos.CancelExecutionResponse(
                    executionId,
                    "resolved",
                    "cancelled",
                    Long.toString(result.sequence())
            ));
        });
    }

    /**
     * 接收并处理由 Electron Daemon 推送的定稿 Agent 消息与执行状态流转。
     *
     * <p>【端云协同原则 (Why)】
     * - 流式渲染 100% 在客户端完成，定稿后一次性 push 到此；
     * - 同指纹与来源序号安全重试直接 ACK，防重放；
     * - 校验状态机变迁合法性，防止客户端上报非法逆向状态；
     * - 短事务推进会话全局序号后，双写 Redis 滑窗并向 Kafka/SSE 广播。
     *
     * @param deviceApp 设备应用服务
     * @param deviceId 设备标识
     * @param connectionId WebSocket 连接通道标识
     * @param conversationId 会话标识
     * @param executionId 执行标识
     * @param runnerSequence 本机 Runner 产生的事件序号
     * @param fingerprint 报文内容指纹
     * @param agentMessageId Agent 消息唯一标识（可为空）
     * @param agentText Agent 消息定稿文本（可为空）
     * @param nextState 执行目标状态（可为空）
     * @param reasonCode 终态原因码
     * @param nativeSessionId 绑定到底层的会话标识
     * @return 确认回执 ExecutionAck
     */
    public ExecutionDtos.ExecutionAck recordDaemonPush(
            DeviceAppService deviceApp,
            String deviceId,
            String connectionId,
            String conversationId,
            String executionId,
            long runnerSequence,
            String fingerprint,
            String agentMessageId,
            String agentText,
            String nextState,
            String reasonCode,
            String nativeSessionId
    ) {
        if (!deviceApp.recordSource(deviceId, connectionId, executionId, runnerSequence, fingerprint)) {
            return new ExecutionDtos.ExecutionAck(executionId, Long.toString(runnerSequence));
        }

        ExecutionState current = executions.find(executionId)
                .filter(found -> found.conversationId().equals(conversationId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));

        boolean hasMessage = agentMessageId != null && !agentMessageId.isEmpty() && agentText != null;
        boolean stateChanged = nextState != null && !nextState.isEmpty() && !nextState.equals(current.state());

        // 状态跃迁校验：直接边校验，或排队态到接单态的合法穿透校验
        boolean legalTransition = stateChanged && (ExecutionStateMachine.legal(current.state(), nextState)
                || ("queued".equals(current.state()) && "accepted".equals(nextState)
                && ExecutionStateMachine.legal("queued", "dispatching")
                && ExecutionStateMachine.legal("dispatching", "accepted")));

        if (stateChanged && !legalTransition) {
            throw new ApiProblem(409, "EXECUTION_STATE_CONFLICT");
        }

        String targetState = stateChanged ? nextState : current.state();
        boolean terminal = ExecutionStateMachine.terminal(targetState);
        int span = (hasMessage ? 1 : 0) + (stateChanged ? 1 : 0);
        long now = System.currentTimeMillis();

        record PushAllocation(Conversation locked, long startSequence) {}

        PushAllocation allocation = inShortTransaction(() -> {
            Conversation locked = conversations.lockById(conversationId)
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
            if (!locked.deviceId().equals(deviceId)) {
                throw new ApiProblem(409, "TARGET_UNAVAILABLE");
            }
            long base = locked.nextSequence();
            long next = span > 0 ? SequenceNumbers.advance(base, span) : base;
            String session = (nativeSessionId != null && !nativeSessionId.isEmpty()) ? nativeSessionId : locked.nativeSessionId();
            String active = terminal ? null : locked.activeExecutionId();
            conversations.update(new Conversation(
                    locked.id(),
                    locked.workspaceId(),
                    locked.title(),
                    locked.createdByUserId(),
                    locked.currentUserId(),
                    locked.deviceId(),
                    locked.projectId(),
                    locked.agentConfigId(),
                    next,
                    session,
                    active,
                    locked.createdAtMs(),
                    now
            ));
            return new PushAllocation(locked, base);
        });

        Conversation locked = allocation.locked();
        long cursor = allocation.startSequence();
        List<String> batch = new ArrayList<>();

        if (hasMessage) {
            long msgSeq = cursor++;
            Message agentMessage = new Message(
                    agentMessageId,
                    locked.workspaceId(),
                    conversationId,
                    executionId,
                    "agent",
                    null,
                    null,
                    null,
                    locked.agentConfigId(),
                    msgSeq,
                    agentText,
                    "completed",
                    now
            );
            messages.save(agentMessage);
            batch.add(encoder.messageCreated(agentMessage, locked.workspaceId(), msgSeq, now));
            bus.publishSearchIndex(locked.workspaceId(), JSON.writeValueAsString(agentMessage));
        }

        if (stateChanged) {
            long execSeq = cursor;
            String cancelState = terminal && !"none".equals(current.cancelState()) ? "resolved" : current.cancelState();
            ExecutionState updated = new ExecutionState(
                    current.executionId(),
                    current.conversationId(),
                    current.inputId(),
                    current.inputSequence(),
                    current.initiatedByUserId(),
                    targetState,
                    targetState,
                    cancelState,
                    reasonCode,
                    current.createdAtMs(),
                    now,
                    current.commandFingerprint()
            );
            executions.save(updated);
            batch.add(encoder.executionChanged(locked.workspaceId(), updated, execSeq, now));
        }

        if (!batch.isEmpty()) {
            emit(conversationId, batch);
        }

        return new ExecutionDtos.ExecutionAck(executionId, Long.toString(runnerSequence));
    }

    /**
     * 在受控短事务中执行数据库写入。
     */
    private <T> T inShortTransaction(Supplier<T> work) {
        if (transaction == null) {
            return work.get();
        }
        return transaction.execute(status -> work.get());
    }

    /**
     * 查询单个执行热状态详情。
     */
    @Transactional(readOnly = true)
    public String execution(String userId, String workspaceId, String conversationId, String executionId) {
        identity.requireMember(workspaceId, userId);
        requireConversation(workspaceId, conversationId);
        ExecutionState state = executions.find(executionId)
                .filter(found -> found.conversationId().equals(conversationId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        return contracts.encode("ExecutionResponse", new ConversationDtos.ExecutionResponse(view(state)));
    }

    /**
     * 分页查询会话历史事件（主要用于客户端离线补齐，直接从 Redis 热滑窗读取）。
     */
    @Transactional(readOnly = true)
    public String history(String userId, String workspaceId, String conversationId, String afterRaw, String throughRaw, int limit) {
        identity.requireMember(workspaceId, userId);
        Conversation conversation = requireConversation(workspaceId, conversationId);
        long high = conversation.nextSequence() - 1;
        long after = afterRaw == null ? 0 : Long.parseLong(afterRaw);
        long through;
        if (throughRaw == null) {
            if (after > high) {
                throw new ApiProblem(409, "CURSOR_AHEAD");
            }
            through = high;
        } else {
            through = Long.parseLong(throughRaw);
            if (through > high) {
                throw new ApiProblem(409, "CURSOR_AHEAD");
            }
        }
        if (after > through) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        var found = new ArrayList<>(events.range(conversationId, after, through, limit + 1));
        boolean more = found.size() > limit;
        if (more) {
            found.subList(limit, found.size()).clear();
        }
        long nextAfter = found.isEmpty() ? after : found.getLast().sequence();
        List<ConversationDtos.ConversationEvent> wire = found.stream()
                .map(row -> contracts.decode("ConversationEvent", row.eventJson(), ConversationDtos.ConversationEvent.class))
                .toList();
        return contracts.encode("HistoryResponse", new ConversationDtos.HistoryResponse(
                conversationId,
                Long.toString(through),
                wire,
                Long.toString(nextAfter),
                more
        ));
    }

    /**
     * 查询指定请求的幂等回执。
     */
    @Transactional(readOnly = true)
    public String receipt(String userId, String workspaceId, String requestId, String operation) {
        identity.requireMember(workspaceId, userId);
        if (operation == null) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        return idempotency.find(workspaceId, userId, operation, requestId)
                .map(response -> contracts.encode("RequestReceiptResponse", new ConversationDtos.RequestReceiptResponse(operation, JSON.readTree(response))))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    /**
     * 分页列出工作区下的所有会话头。
     */
    @Transactional(readOnly = true)
    public String list(String userId, String workspaceId, String beforeCreatedAt, String beforeId, int limit) {
        identity.requireMember(workspaceId, userId);
        Long beforeMs = beforeCreatedAt == null ? null : TimeCodec.epoch(beforeCreatedAt);
        List<Conversation> found = conversations.list(workspaceId, beforeMs, beforeId, limit + 1);
        boolean more = found.size() > limit;
        if (more) {
            found = found.subList(0, limit);
        }
        ConversationDtos.ConversationPageCursor cursor = more
                ? new ConversationDtos.ConversationPageCursor(TimeCodec.utc(found.getLast().createdAtMs()), found.getLast().id())
                : null;
        return contracts.encode("ConversationListResponse", new ConversationDtos.ConversationListResponse(
                found.stream().map(this::summary).toList(),
                cursor
        ));
    }

    /**
     * 获取单个会话头详情。
     */
    @Transactional(readOnly = true)
    public String get(String userId, String workspaceId, String conversationId) {
        identity.requireMember(workspaceId, userId);
        return contracts.encode("ConversationResponse", new ConversationDtos.ConversationResponse(
                summary(requireConversation(workspaceId, conversationId))
        ));
    }

    /**
     * 获取会话存在性保障实体。
     */
    @Transactional(readOnly = true)
    public Conversation requireConversation(String workspaceId, String conversationId) {
        return conversations.findById(conversationId)
                .filter(conversation -> conversation.workspaceId().equals(workspaceId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    /**
     * 获取当前会话已分配的最高序号水位 (nextSequence - 1)。
     */
    public long highWater(String conversationId) {
        return conversations.findById(conversationId)
                .map(conversation -> conversation.nextSequence() - 1)
                .orElse(0L);
    }

    private SharedProject requireTarget(String workspaceId, String deviceId, String projectId, String agentConfigId) {
        Device device = devices.findById(deviceId)
                .filter(found -> found.workspaceId().equals(workspaceId) && !found.revoked())
                .orElseThrow(() -> new ApiProblem(409, "TARGET_UNAVAILABLE"));
        SharedProject project = devices.findProject(workspaceId, projectId)
                .filter(found -> found.deviceId().equals(device.id()))
                .orElseThrow(() -> new ApiProblem(409, "TARGET_UNAVAILABLE"));
        boolean available = configAvailable(project.agentConfigsJson(), agentConfigId);
        if (!project.shareEnabled()) {
            throw new ApiProblem(409, "PROJECT_NOT_SHARED");
        }
        if (!ExecutionAuthDomainService.canStart(true, available)) {
            throw new ApiProblem(409, "TARGET_UNAVAILABLE");
        }
        return project;
    }

    private static boolean configAvailable(String configsJson, String agentConfigId) {
        JsonNode configs = JSON.readTree(configsJson);
        if (!configs.isArray()) {
            return false;
        }
        for (JsonNode config : configs) {
            if (agentConfigId.equals(config.path("agentConfigId").asString()) && config.path("available").asBoolean(false)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 批量追加本地事件滑窗并向消息总线实时发布。
     *
     * <p>【并发同步 (Why)】
     * 获取会话专属 ReentrantLock，防止多线程并发追加滑窗时出现事件交错或乱序。
     */
    private void emit(String conversationId, List<String> batch) {
        ReentrantLock lock = hub.lock(conversationId);
        lock.lock();
        try {
            for (String event : batch) {
                events.append(conversationId, Long.parseLong(JSON.readTree(event).path("sequence").asString()), event);
                bus.publishConversationEvent(conversationId, event);
            }
        } finally {
            lock.unlock();
        }
    }

    private ConversationDtos.ConversationSummary summary(Conversation conversation) {
        return new ConversationDtos.ConversationSummary(
                conversation.id(),
                conversation.workspaceId(),
                conversation.title(),
                conversation.createdByUserId(),
                conversation.currentUserId(),
                conversation.deviceId(),
                conversation.projectId(),
                conversation.agentConfigId(),
                TimeCodec.utc(conversation.createdAtMs())
        );
    }

    private ConversationDtos.ExecutionView view(ExecutionState state) {
        return new ConversationDtos.ExecutionView(
                state.executionId(),
                state.conversationId(),
                state.inputId(),
                Long.toString(state.inputSequence()),
                state.initiatedByUserId(),
                state.state(),
                state.lastConfirmedState(),
                state.cancelState(),
                state.reasonCode(),
                TimeCodec.utc(state.createdAtMs()),
                TimeCodec.utc(state.updatedAtMs())
        );
    }
}
