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
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceHeartbeatPort;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ConversationDtos;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 模块：设备会话同步与心跳应用服务 (ConversationSyncAppService)
 *
 * <p>【功能定义】
 * 设备凭据域的唯二上传通道：
 * 1. sync——主人 Runner 上传定稿消息批次与简报；
 * 2. heartbeat——设备宣告在线（仅展示用途，不做授权判断）。
 * Java 严格只进不出：校验、写热窗、推水位、广播简报事件，绝不向任何设备下发命令（D1）。
 *
 * <p>【同步流水线（spec §4.3）】
 * 认证 → 行锁读会话 → requireSyncAuthority（设备属会话 owner 且 owner 仍是项目活跃成员）
 * → SyncBatch 校验（重放幂等/连续/类型/尺寸）→ 消息写热窗 + 投递 wb.search.index
 * → 更新会话行（status/brief/watermark/updated_at）→ NotificationPort 广播
 * brief_updated → 输出 {syncedSequence}；跳号 409 带 expectedSequence。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceSyncController。
 * - 下游依赖方：DeviceAppService（Bearer 认证）、ConversationRepository、
 *   MessageStorePort、SearchIndexBus、DeviceHeartbeatPort、NotificationPort、Contracts。
 */
@Service
public class ConversationSyncAppService {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final DeviceAppService devices;
    private final ConversationRepository conversations;
    private final MessageStorePort messages;
    private final SearchIndexBus searchIndex;
    private final DeviceHeartbeatPort heartbeats;
    private final NotificationPort notifications;
    private final ProjectAccessPolicy policy;
    private final Contracts contracts;

    public ConversationSyncAppService(
            DeviceAppService devices,
            ConversationRepository conversations,
            MessageStorePort messages,
            SearchIndexBus searchIndex,
            DeviceHeartbeatPort heartbeats,
            NotificationPort notifications,
            ProjectAccessPolicy policy,
            Contracts contracts
    ) {
        this.devices = devices;
        this.conversations = conversations;
        this.messages = messages;
        this.searchIndex = searchIndex;
        this.heartbeats = heartbeats;
        this.notifications = notifications;
        this.policy = policy;
        this.contracts = contracts;
    }

    /**
     * 主人设备上传定稿消息批次与简报。
     * 整批序号 ≤ 水位 → 幂等返回当前水位；跳号 → 409 SEQUENCE_CONFLICT（带 expectedSequence）。
     *
     * @param authorization Bearer 设备凭据头
     * @param conversationId 会话标识
     * @param rawBody 同步请求原始 JSON
     * @return 确认水位响应 JSON
     */
    @Transactional
    public String sync(String authorization, String conversationId, String rawBody) {
        Device device = devices.authenticate(authorization);
        ConversationDtos.DeviceSyncRequest request = contracts.decode(
                "DeviceSyncRequest", rawBody, ConversationDtos.DeviceSyncRequest.class);
        // 短事务内行锁会话：水位校验与推进原子化，防并发批次互相覆盖
        Conversation conversation = conversations.lockById(conversationId)
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        policy.requireSyncAuthority(device, conversation);

        List<ConversationDtos.SyncMessage> batch = request.messages() == null ? List.of() : request.messages();
        List<SyncBatch.Item> items = batch.stream()
                .map(m -> new SyncBatch.Item(m.sequence(), m.type(), m.occurredAtMs(), m.payload()))
                .toList();
        if (SyncBatch.validate(conversation.syncedSequence(), items) == SyncBatch.Verdict.REPLAY) {
            return contracts.encode("DeviceSyncResponse",
                    new ConversationDtos.DeviceSyncResponse(conversation.syncedSequence()));
        }

        for (SyncBatch.Item item : items) {
            Message message = new Message(
                    UUID.randomUUID().toString(), conversation.workspaceId(), conversationId,
                    item.type(), item.sequence(), item.payload(), item.occurredAtMs());
            messages.save(message);
            // 投递检索索引通道（wb.search.index）：Kafka 削峰后按文档 ID 幂等 upsert 入 ES
            searchIndex.publishSearchIndex(conversation.workspaceId(), JSON.writeValueAsString(message));
        }

        long now = System.currentTimeMillis();
        ConversationDtos.SyncBrief syncBrief = request.brief();
        Brief brief = syncBrief == null ? null : new Brief(syncBrief.status(), syncBrief.briefText(), syncBrief.briefSource());
        long watermark = items.isEmpty() ? conversation.syncedSequence() : items.getLast().sequence();
        long briefUpdatedAt = brief != null ? now : conversation.briefUpdatedAtMs();
        Conversation updated = new Conversation(
                conversation.id(), conversation.workspaceId(), conversation.projectId(), conversation.ownerUserId(),
                conversation.deviceId(), conversation.agentConfigId(), conversation.taskId(),
                brief != null && brief.status() != null ? brief.status() : conversation.status(),
                conversation.title(),
                // briefText 为 null 表示清空简报——落库统一 '' 空串哨兵（全列 NOT NULL）
                brief != null ? (brief.briefText() == null ? "" : brief.briefText()) : conversation.briefText(),
                brief != null && brief.briefSource() != null ? brief.briefSource() : conversation.briefSource(),
                briefUpdatedAt,
                watermark, conversation.nativeSessionId(), conversation.createdAtMs(), now);
        conversations.update(updated);

        // 会话头也入检索索引（wb_conversation_v1），供简报看板全文检索
        searchIndex.publishSearchIndex(conversation.workspaceId(), JSON.writeValueAsString(Map.of(
                "conversationId", updated.id(),
                "projectId", updated.projectId(),
                "ownerUserId", updated.ownerUserId(),
                "title", updated.title(),
                "status", updated.status(),
                "briefText", updated.briefText(),
                "briefSource", updated.briefSource(),
                "briefUpdatedAtMs", updated.briefUpdatedAtMs(),
                "syncedSequence", updated.syncedSequence(),
                "updatedAtMs", now)));

        notifications.publish("conversation.brief_updated", updated.id(), Map.of(
                "projectId", updated.projectId(),
                "ownerUserId", updated.ownerUserId(),
                "status", updated.status(),
                "briefSource", updated.briefSource(),
                "syncedSequence", updated.syncedSequence()));

        return contracts.encode("DeviceSyncResponse", new ConversationDtos.DeviceSyncResponse(watermark));
    }

    /**
     * 设备心跳：刷新在线展示键（TTL 45s，仅展示不做授权）。
     */
    @Transactional(readOnly = true)
    public void heartbeat(String authorization) {
        Device device = devices.authenticate(authorization);
        heartbeats.beat(device.id(), System.currentTimeMillis());
    }
}
