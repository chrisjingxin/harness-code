package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ConversationDtos;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 模块：项目内会话只读共享应用服务 (ConversationAppService)
 *
 * <p>【功能定义】
 * 承载用户会话侧的项目内会话面：登记会话头、按人/状态过滤的简报列表、
 * 单条简报详情与序号增量历史。会话正文只覆盖"主人已上传"的部分（D10），
 * Java 只读不回写消息（写通道在 ConversationSyncAppService 设备侧）。
 *
 * <p>【安全原则 (Why)】
 * - 所有读前置 requireProject + requireActiveMember：非成员/已移出一律 404；
 * - 登记的 deviceId 必须是调用者本人未吊销设备，repositoryIds ⊆ 项目引用集合；
 * - 归档项目禁止登记（requireActiveProject → 409 PROJECT_ARCHIVED）。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectConversationController。
 * - 下游依赖方：ProjectAccessPolicy、ConversationRepository、MessageStorePort、
 *   ProjectRepository、RepositoryCatalog、DeviceRepository、IdempotencyPort、Contracts。
 */
@Service
public class ConversationAppService {

    private static final int BRIEF_LIST_LIMIT = 500;

    private final ProjectAccessPolicy policy;
    private final ConversationRepository conversations;
    private final MessageStorePort messages;
    private final ProjectRepository projects;
    private final RepositoryCatalog repositories;
    private final DeviceRepository devices;
    private final IdempotencyPort idempotency;
    private final Contracts contracts;

    public ConversationAppService(
            ProjectAccessPolicy policy,
            ConversationRepository conversations,
            MessageStorePort messages,
            ProjectRepository projects,
            RepositoryCatalog repositories,
            DeviceRepository devices,
            IdempotencyPort idempotency,
            Contracts contracts
    ) {
        this.policy = policy;
        this.conversations = conversations;
        this.messages = messages;
        this.projects = projects;
        this.repositories = repositories;
        this.devices = devices;
        this.idempotency = idempotency;
        this.contracts = contracts;
    }

    /**
     * 项目成员登记会话头（owner=调用者）。
     * deviceId 必须是本人未吊销设备；repositoryIds 为空或 ⊆ 项目引用，否则 400。
     */
    @Transactional
    public String register(String userId, String workspaceId, String projectId, String rawBody) {
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        ConversationDtos.ConversationRegisterRequest request = contracts.decode(
                "ConversationRegisterRequest", rawBody, ConversationDtos.ConversationRegisterRequest.class);
        return IdempotentCalls.run(idempotency, workspaceId, userId, "conversation.register", request.requestId(),
                IdempotentCalls.fingerprint(projectId, rawBody), () -> {
                    Device device = devices.findById(request.deviceId())
                            .orElseThrow(() -> new ApiProblem(400, "INVALID_REQUEST"));
                    if (!device.ownerUserId().equals(userId) || device.revoked()) {
                        throw new ApiProblem(400, "INVALID_REQUEST");
                    }
                    List<String> repositoryIds = request.repositoryIds() == null ? List.of() : request.repositoryIds();
                    Set<String> referenced = projects.listReferences(projectId).stream()
                            .map(ref -> ref.repositoryId())
                            .collect(Collectors.toSet());
                    if (!referenced.containsAll(repositoryIds)) {
                        throw new ApiProblem(400, "INVALID_REQUEST");
                    }
                    long now = System.currentTimeMillis();
                    Conversation conversation = new Conversation(
                            UUID.randomUUID().toString(), workspaceId, projectId, userId,
                            request.deviceId(), "", request.taskId() == null ? "" : request.taskId(), "idle",
                            request.title() != null ? request.title() : "未命名会话",
                            "", "rule", now, 0L, "", now, now);
                    conversations.insert(conversation);
                    conversations.insertRepositoryRefs(conversation.id(), repositoryIds, now);
                    return contracts.encode("ConversationDetailResponse",
                            new ConversationDtos.ConversationDetailResponse(summary(conversation)));
                });
    }

    /**
     * 项目内会话简报列表；ownerId/status 可过滤（看板按人分组）。
     */
    @Transactional(readOnly = true)
    public String list(String userId, String workspaceId, String projectId, String ownerId, String status) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        List<ConversationDtos.ConversationSummary> found = conversations
                .listByProject(projectId, ownerId, status, BRIEF_LIST_LIMIT).stream()
                .map(this::summary)
                .toList();
        return contracts.encode("ConversationListResponse",
                new ConversationDtos.ConversationListResponse(projectId, found));
    }

    /**
     * 单条会话简报详情（含登记时的仓库快照）。
     */
    @Transactional(readOnly = true)
    public String detail(String userId, String workspaceId, String projectId, String conversationId) {
        Conversation conversation = requireProjectConversation(userId, workspaceId, projectId, conversationId);
        return contracts.encode("ConversationDetailResponse",
                new ConversationDtos.ConversationDetailResponse(summary(conversation)));
    }

    /**
     * 序号增量历史：afterSequence 之后的消息 + 当前水位。
     * 热窗优先、缺段回源 ES（由 MessageStorePort.after 内部裁决）。
     */
    @Transactional(readOnly = true)
    public String history(
            String userId, String workspaceId, String projectId, String conversationId,
            long afterSequence, int limit
    ) {
        Conversation conversation = requireProjectConversation(userId, workspaceId, projectId, conversationId);
        List<ConversationDtos.HistoryMessage> found = messages
                .after(workspaceId, conversationId, afterSequence, limit).stream()
                .map(message -> new ConversationDtos.HistoryMessage(
                        message.sequence(), message.type(), message.occurredAtMs(), message.payload()))
                .toList();
        return contracts.encode("ConversationHistoryResponse", new ConversationDtos.ConversationHistoryResponse(
                conversationId, conversation.syncedSequence(), found));
    }

    private Conversation requireProjectConversation(String userId, String workspaceId, String projectId, String conversationId) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        return conversations.findById(conversationId)
                .filter(found -> found.projectId().equals(projectId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    private ConversationDtos.ConversationSummary summary(Conversation conversation) {
        List<ConversationDtos.ConversationRepositoryItem> refs = conversations
                .listRepositoryIds(conversation.id()).stream()
                .map(id -> {
                    var repository = repositories.findById(id).orElse(null);
                    return new ConversationDtos.ConversationRepositoryItem(
                            id, repository != null ? repository.name() : "");
                })
                .toList();
        return new ConversationDtos.ConversationSummary(
                conversation.id(), conversation.projectId(), conversation.ownerUserId(), conversation.deviceId(),
                conversation.title(), conversation.status(), conversation.briefText(), conversation.briefSource(),
                conversation.briefUpdatedAtMs(), conversation.syncedSequence(),
                TimeCodec.utc(conversation.updatedAtMs()), refs);
    }
}
