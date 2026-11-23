package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.application.port.SearchIndexBus;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ConversationDtos;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 模块：项目内会话共享应用服务 (ConversationAppService)
 *
 * <p>【功能定义】
 * 承载用户会话侧的项目内会话面：登记会话头、按人/状态过滤的简报列表、
 * 单条简报详情、序号增量历史与停止共享。会话正文只覆盖"主人已上传"的部分（D10），
 * 写通道由 ConversationSyncAppService 在同一用户会话鉴权下受理。
 *
 * <p>【安全原则 (Why)】
 * - 所有读前置 requireProject + requireActiveMember：非成员/已移出一律 404；
 * - repositoryIds ⊆ 项目引用集合；
 * - 归档项目禁止登记（requireActiveProject → 409 PROJECT_ARCHIVED），但允许所有者停止共享止损；
 * - summary_only 档位绝不返回消息历史正文。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectConversationController。
 * - 下游依赖方：ProjectAccessPolicy、ConversationRepository、MessageStorePort、
 *   ProjectRepository、RepositoryCatalog、IdempotencyPort、Contracts、NotificationPort、SearchIndexBus。
 */
@Service
public class ConversationAppService {

    private static final int BRIEF_LIST_LIMIT = 500;
    private static final int MAX_BRIEF_TEXT_LENGTH = 2000;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final ProjectAccessPolicy policy;
    private final ConversationRepository conversations;
    private final MessageStorePort messages;
    private final ProjectRepository projects;
    private final RepositoryCatalog repositories;
    private final IdempotencyPort idempotency;
    private final Contracts contracts;
    private final NotificationPort notifications;
    private final SearchIndexBus searchIndex;

    public ConversationAppService(
            ProjectAccessPolicy policy,
            ConversationRepository conversations,
            MessageStorePort messages,
            ProjectRepository projects,
            RepositoryCatalog repositories,
            IdempotencyPort idempotency,
            Contracts contracts,
            NotificationPort notifications,
            SearchIndexBus searchIndex
    ) {
        this.policy = policy;
        this.conversations = conversations;
        this.messages = messages;
        this.projects = projects;
        this.repositories = repositories;
        this.idempotency = idempotency;
        this.contracts = contracts;
        this.notifications = notifications;
        this.searchIndex = searchIndex;
    }

    /**
     * 项目成员登记会话头（owner=调用者）；支持个人会话携带原 conversationId、两档 shareMode 与初始简报发布。
     * repositoryIds 为空或 ⊆ 项目引用，否则 400。
     */
    @Transactional
    public String register(String userId, String workspaceId, String projectId, String rawBody) {
        policy.requireWorkspaceMember(workspaceId, userId);
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        ConversationDtos.ConversationRegisterRequest request = contracts.decode(
                "ConversationRegisterRequest", rawBody, ConversationDtos.ConversationRegisterRequest.class);
        return IdempotentCalls.run(idempotency, workspaceId, userId, "conversation.register", request.requestId(),
                IdempotentCalls.fingerprint(projectId, rawBody), () -> {
                    List<String> repositoryIds = request.repositoryIds() == null ? List.of() : request.repositoryIds();
                    Set<String> referenced = projects.listReferences(projectId).stream()
                            .map(ref -> ref.repositoryId())
                            .collect(Collectors.toSet());
                    if (!referenced.containsAll(repositoryIds)) {
                        throw new ApiProblem(400, "INVALID_REQUEST");
                    }
                    String conversationId = request.conversationId() != null
                            ? request.conversationId()
                            : UUID.randomUUID().toString();
                    if (request.conversationId() != null && conversations.findById(conversationId).isPresent()) {
                        throw new ApiProblem(409, "CONVERSATION_CONFLICT");
                    }
                    String shareMode = request.shareMode() != null ? request.shareMode() : "full";
                    ConversationDtos.SyncBrief initialBrief = request.initialBrief();
                    String initialStatus = initialBrief != null && initialBrief.status() != null
                            ? initialBrief.status()
                            : "idle";
                    String initialBriefText = initialBrief != null && initialBrief.briefText() != null
                            ? initialBrief.briefText()
                            : "";
                    if (initialBriefText.length() > MAX_BRIEF_TEXT_LENGTH) {
                        throw new ApiProblem(400, "INVALID_REQUEST");
                    }
                    String initialBriefSource = initialBrief != null && initialBrief.briefSource() != null
                            ? initialBrief.briefSource()
                            : "rule";
                    long now = System.currentTimeMillis();
                    Conversation conversation = new Conversation(
                            conversationId, workspaceId, projectId, userId,
                            "", "", initialStatus,
                            request.title() != null ? request.title() : "未命名会话",
                            initialBriefText, initialBriefSource, now, 0L, "",
                            shareMode, "active", now, now, now);
                    conversations.insert(conversation);
                    conversations.insertRepositoryRefs(conversation.id(), repositoryIds, now);
                    publishConversationIndex(conversation);
                    if (initialBrief != null) {
                        publishBriefUpdatedNotification(conversation);
                    }
                    return contracts.encode("ConversationDetailResponse",
                            new ConversationDtos.ConversationDetailResponse(summary(conversation)));
                });
    }

    /**
     * 项目内会话简报列表；ownerId/status 可过滤（看板按人分组）。
     */
    @Transactional(readOnly = true)
    public String list(String userId, String workspaceId, String projectId, String ownerId, String status) {
        policy.requireWorkspaceMember(workspaceId, userId);
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
        policy.requireWorkspaceMember(workspaceId, userId);
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
        policy.requireWorkspaceMember(workspaceId, userId);
        Conversation conversation = requireProjectConversation(userId, workspaceId, projectId, conversationId);
        // summary_only 档位严禁返回历史消息正文，始终返回 0 水位空集合
        if ("summary_only".equals(conversation.shareMode())) {
            return contracts.encode("ConversationHistoryResponse",
                    new ConversationDtos.ConversationHistoryResponse(conversationId, 0L, List.of()));
        }
        List<ConversationDtos.HistoryMessage> found = messages
                .after(workspaceId, conversationId, afterSequence, limit).stream()
                .map(message -> new ConversationDtos.HistoryMessage(
                        message.sequence(), message.type(), message.occurredAtMs(), message.payload()))
                .toList();
        return contracts.encode("ConversationHistoryResponse", new ConversationDtos.ConversationHistoryResponse(
                conversationId, conversation.syncedSequence(), found));
    }

    /**
     * 会话创建者停止继续向团队同步该会话；允许归档项目内的所有者止损，重复调用幂等返回。
     */
    @Transactional
    public String stopSharing(String userId, String workspaceId, String projectId, String conversationId) {
        policy.requireWorkspaceMember(workspaceId, userId);
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        Conversation conversation = conversations.lockById(conversationId)
                .filter(found -> found.projectId().equals(projectId) && found.workspaceId().equals(workspaceId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        policy.requireConversationOwner(conversation, userId);
        if ("stopped".equals(conversation.shareStatus())) {
            return contracts.encode("ConversationDetailResponse",
                    new ConversationDtos.ConversationDetailResponse(summary(conversation)));
        }
        long now = System.currentTimeMillis();
        Conversation updated = new Conversation(
                conversation.id(), conversation.workspaceId(), conversation.projectId(), conversation.ownerUserId(),
                conversation.agentConfigId(), conversation.taskId(),
                conversation.status(), conversation.title(),
                conversation.briefText(), conversation.briefSource(),
                conversation.briefUpdatedAtMs(), conversation.syncedSequence(),
                conversation.nativeSessionId(), conversation.shareMode(),
                "stopped", now, conversation.createdAtMs(), now);
        conversations.update(updated);
        publishConversationIndex(updated);
        publishBriefUpdatedNotification(updated);
        return contracts.encode("ConversationDetailResponse",
                new ConversationDtos.ConversationDetailResponse(summary(updated)));
    }

    private Conversation requireProjectConversation(String userId, String workspaceId, String projectId, String conversationId) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        return conversations.findById(conversationId)
                .filter(found -> found.projectId().equals(projectId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    ConversationDtos.ConversationSummary summary(Conversation conversation) {
        List<ConversationDtos.ConversationRepositoryItem> refs = conversations
                .listRepositoryIds(conversation.id()).stream()
                .map(id -> {
                    var repository = repositories.findById(id).orElse(null);
                    return new ConversationDtos.ConversationRepositoryItem(
                            id, repository != null ? repository.name() : "");
                })
                .toList();
        String stoppedAt = "stopped".equals(conversation.shareStatus())
                ? TimeCodec.utc(conversation.stoppedAtMs())
                : null;
        return new ConversationDtos.ConversationSummary(
                conversation.id(), conversation.projectId(), conversation.ownerUserId(),
                conversation.title(), conversation.status(), conversation.briefText(), conversation.briefSource(),
                conversation.briefUpdatedAtMs(), conversation.syncedSequence(),
                TimeCodec.utc(conversation.updatedAtMs()),
                conversation.shareMode(), conversation.shareStatus(), stoppedAt, refs);
    }

    private void publishConversationIndex(Conversation conversation) {
        searchIndex.publishSearchIndex(conversation.workspaceId(), JSON.writeValueAsString(Map.ofEntries(
                Map.entry("conversationId", conversation.id()),
                Map.entry("projectId", conversation.projectId()),
                Map.entry("ownerUserId", conversation.ownerUserId()),
                Map.entry("title", conversation.title()),
                Map.entry("status", conversation.status()),
                Map.entry("briefText", conversation.briefText()),
                Map.entry("briefSource", conversation.briefSource()),
                Map.entry("shareMode", conversation.shareMode()),
                Map.entry("shareStatus", conversation.shareStatus()),
                Map.entry("briefUpdatedAtMs", conversation.briefUpdatedAtMs()),
                Map.entry("syncedSequence", conversation.syncedSequence()),
                Map.entry("updatedAtMs", conversation.updatedAtMs()))));
    }

    private void publishBriefUpdatedNotification(Conversation conversation) {
        notifications.publish("conversation.brief_updated", conversation.id(), Map.of(
                "workspaceId", conversation.workspaceId(),
                "actorId", conversation.ownerUserId(),
                "projectId", conversation.projectId(),
                "ownerUserId", conversation.ownerUserId(),
                "status", conversation.status(),
                "briefSource", conversation.briefSource(),
                "syncedSequence", conversation.syncedSequence()));
    }
}
