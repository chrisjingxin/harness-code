package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.application.port.SearchIndexBus;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Brief;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.conversation.SyncBatch;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ConversationDtos;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 模块：会话同步应用服务 (ConversationSyncAppService)
 *
 * <p>【功能定义】
 * 承载当前登录用户在项目内对本人所创建会话的定稿消息与简报上传通道：
 * 校验项目成员资格与会话创建者归属、写热滑窗、推进水位并广播简报更新事件。
 *
 * <p>【同步流水线】
 * 校验项目与活跃成员（404 防泄露）→ 行锁读会话 → 校验会话属于当前项目（404）→
 * requireConversationOwner（非创建者 403 CONVERSATION_FORBIDDEN）
 * → SyncBatch 校验（重放幂等/连续/类型/尺寸）→ 消息写热窗 + 投递 wb.search.index
 * → 更新会话行（status/brief/watermark/updated_at）→ NotificationPort 广播
 * brief_updated → 输出 {syncedSequence}；跳号 409 带 expectedSequence。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectConversationController。
 * - 下游依赖方：ProjectAccessPolicy、ConversationRepository、
 *   MessageStorePort、SearchIndexBus、NotificationPort、Contracts。
 */
@Service
public class ConversationSyncAppService {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final ConversationRepository conversations;
    private final MessageStorePort messages;
    private final SearchIndexBus searchIndex;
    private final NotificationPort notifications;
    private final ProjectAccessPolicy policy;
    private final Contracts contracts;

    public ConversationSyncAppService(
            ConversationRepository conversations,
            MessageStorePort messages,
            SearchIndexBus searchIndex,
            NotificationPort notifications,
            ProjectAccessPolicy policy,
            Contracts contracts
    ) {
        this.conversations = conversations;
        this.messages = messages;
        this.searchIndex = searchIndex;
        this.notifications = notifications;
        this.policy = policy;
        this.contracts = contracts;
    }

    /**
     * 会话创建者上传定稿消息批次与简报。
     * 整批序号 ≤ 水位 → 幂等返回当前水位；跳号 → 409 SEQUENCE_CONFLICT（带 expectedSequence）。
     *
     * @param userId 当前登录用户标识
     * @param workspaceId 所属工作区标识
     * @param projectId 所属项目标识
     * @param conversationId 会话标识
     * @param rawBody 同步请求原始 JSON
     * @return 确认水位响应 JSON
     */
    @Transactional
    public String sync(String userId, String workspaceId, String projectId, String conversationId, String rawBody) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        ConversationDtos.ConversationSyncRequest request = contracts.decode(
                "ConversationSyncRequest", rawBody, ConversationDtos.ConversationSyncRequest.class);
        // 短事务内行锁会话：水位校验与推进原子化，防并发批次互相覆盖
        Conversation conversation = conversations.lockById(conversationId)
                .filter(found -> found.projectId().equals(projectId) && found.workspaceId().equals(workspaceId))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        policy.requireConversationOwner(conversation, userId);
        // 一旦停止共享，拒绝一切后续增量上传，明确通知客户端停止重传并解除待传队列
        if ("stopped".equals(conversation.shareStatus())) {
            throw new ApiProblem(409, "CONVERSATION_SHARING_STOPPED");
        }

        List<ConversationDtos.SyncMessage> batch = request.messages() == null ? List.of() : request.messages();
        // summary_only 会话禁止上传对话消息正文或工具明细，防止个人试错上下文泄漏到团队云端
        if ("summary_only".equals(conversation.shareMode()) && !batch.isEmpty()) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        List<SyncBatch.Item> items = batch.stream()
                .map(m -> new SyncBatch.Item(m.sequence(), m.type(), m.occurredAtMs(), m.payload()))
                .toList();
        if (SyncBatch.validate(conversation.syncedSequence(), items) == SyncBatch.Verdict.REPLAY) {
            return contracts.encode("ConversationSyncResponse",
                    new ConversationDtos.ConversationSyncResponse(conversation.syncedSequence()));
        }

        List<Message> batchMessages = new ArrayList<>(items.size());
        for (SyncBatch.Item item : items) {
            batchMessages.add(new Message(
                    Message.deterministicId(conversationId, item.sequence()),
                    conversation.workspaceId(), conversationId,
                    item.type(), item.sequence(), item.payload(), item.occurredAtMs()));
        }

        long now = System.currentTimeMillis();
        ConversationDtos.SyncBrief syncBrief = request.brief();
        Brief brief = syncBrief == null ? null : new Brief(syncBrief.status(), syncBrief.briefText(), syncBrief.briefSource());
        long watermark = items.isEmpty() ? conversation.syncedSequence() : items.getLast().sequence();
        long briefUpdatedAt = brief != null ? now : conversation.briefUpdatedAtMs();
        Conversation updated = new Conversation(
                conversation.id(), conversation.workspaceId(), conversation.projectId(), conversation.ownerUserId(),
                conversation.agentConfigId(), conversation.taskId(),
                brief != null && brief.status() != null ? brief.status() : conversation.status(),
                conversation.title(),
                // briefText 为 null 表示清空简报——落库统一 '' 空串哨兵（全列 NOT NULL）
                brief != null ? (brief.briefText() == null ? "" : brief.briefText()) : conversation.briefText(),
                brief != null && brief.briefSource() != null ? brief.briefSource() : conversation.briefSource(),
                briefUpdatedAt,
                watermark, conversation.nativeSessionId(),
                conversation.shareMode(), conversation.shareStatus(), conversation.stoppedAtMs(),
                conversation.createdAtMs(), now);
        conversations.update(updated);
        // 先更新会话行再持久化消息：若 ES/Redis 写入失败抛 503，事务整体回滚，水位绝不虚推
        messages.saveAll(batchMessages);

        for (Message message : batchMessages) {
            // 投递检索索引通道（wb.search.index）：事务提交后经 Kafka 异步幂等 upsert
            searchIndex.publishSearchIndex(conversation.workspaceId(), JSON.writeValueAsString(message));
        }

        // 会话头也入检索索引（wb_conversation_v1），供简报看板全文检索
        searchIndex.publishSearchIndex(conversation.workspaceId(), JSON.writeValueAsString(Map.ofEntries(
                Map.entry("conversationId", updated.id()),
                Map.entry("projectId", updated.projectId()),
                Map.entry("ownerUserId", updated.ownerUserId()),
                Map.entry("title", updated.title()),
                Map.entry("status", updated.status()),
                Map.entry("briefText", updated.briefText()),
                Map.entry("briefSource", updated.briefSource()),
                Map.entry("shareMode", updated.shareMode()),
                Map.entry("shareStatus", updated.shareStatus()),
                Map.entry("briefUpdatedAtMs", updated.briefUpdatedAtMs()),
                Map.entry("syncedSequence", updated.syncedSequence()),
                Map.entry("updatedAtMs", now))));

        notifications.publish("conversation.brief_updated", updated.id(), Map.of(
                "workspaceId", updated.workspaceId(), "actorId", updated.ownerUserId(),
                "projectId", updated.projectId(),
                "ownerUserId", updated.ownerUserId(),
                "status", updated.status(),
                "briefSource", updated.briefSource(),
                "syncedSequence", updated.syncedSequence()));

        return contracts.encode("ConversationSyncResponse", new ConversationDtos.ConversationSyncResponse(watermark));
    }
}
