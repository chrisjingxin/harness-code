package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.conversation.Conversation;

/**
 * 模块：会话持久化对象与领域模型转换器 (ConversationConverter)
 *
 * <p>【功能定义】
 * 提供 Conversation 领域聚合根与 ConversationPO 数据表持久化对象之间的双向转换。
 * 遵循空值保留契约：taskId、agentConfigId、briefText、briefUpdatedAtMs、nativeSessionId
 * 为空时必须保留 null 语义，供底层 UpdateWrapper 正确执行清空操作。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationRepositoryImpl。
 * - 下游依赖方：Conversation、ConversationPO。
 */
final class ConversationConverter {

    private ConversationConverter() {}

    static ConversationPO toPo(Conversation conversation) {
        ConversationPO po = new ConversationPO();
        po.setId(conversation.id());
        po.setWorkspaceId(conversation.workspaceId());
        po.setProjectId(conversation.projectId());
        po.setOwnerUserId(conversation.ownerUserId());
        po.setDeviceId(conversation.deviceId());
        po.setAgentConfigId(conversation.agentConfigId());
        po.setTaskId(conversation.taskId());
        po.setStatus(conversation.status());
        po.setTitle(conversation.title());
        po.setBriefText(conversation.briefText());
        po.setBriefSource(conversation.briefSource());
        po.setBriefUpdatedAtMs(conversation.briefUpdatedAtMs());
        po.setSyncedSequence(conversation.syncedSequence());
        po.setNativeSessionId(conversation.nativeSessionId());
        po.setCreatedAtMs(conversation.createdAtMs());
        po.setUpdatedAtMs(conversation.updatedAtMs());
        return po;
    }

    static Conversation toConversation(ConversationPO po) {
        return new Conversation(
                po.getId(),
                po.getWorkspaceId(),
                po.getProjectId(),
                po.getOwnerUserId(),
                po.getDeviceId(),
                po.getAgentConfigId(),
                po.getTaskId(),
                po.getStatus(),
                po.getTitle(),
                po.getBriefText(),
                po.getBriefSource(),
                po.getBriefUpdatedAtMs(),
                po.getSyncedSequence(),
                po.getNativeSessionId(),
                po.getCreatedAtMs(),
                po.getUpdatedAtMs()
        );
    }
}
