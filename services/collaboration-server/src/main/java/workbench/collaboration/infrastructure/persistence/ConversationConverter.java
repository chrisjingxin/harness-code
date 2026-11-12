package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.conversation.BriefSource;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationStatus;

/**
 * 模块：会话持久化对象与领域模型转换器 (ConversationConverter)
 *
 * <p>【功能定义】
 * 提供 Conversation 领域聚合根与 ConversationPO 数据表持久化对象之间的双向转换。
 * 存储形态：status/brief_source 落库为 TINYINT 数值码，领域层保持契约字符串；
 * 未绑定语义在库表与领域层统一用 '' 空串表达（规范：全部列 NOT NULL）。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationRepositoryImpl。
 * - 下游依赖方：Conversation、ConversationPO。
 */
final class ConversationConverter {

    private ConversationConverter() {}

    static ConversationPO toPo(Conversation conversation) {
        ConversationPO po = new ConversationPO();
        po.setConversationId(conversation.id());
        po.setWorkspaceId(conversation.workspaceId());
        po.setProjectId(conversation.projectId());
        po.setOwnerUserId(conversation.ownerUserId());
        po.setDeviceId(conversation.deviceId());
        po.setAgentConfigId(conversation.agentConfigId());
        po.setTaskId(conversation.taskId());
        po.setStatus(ConversationStatus.dbOf(conversation.status()));
        po.setTitle(conversation.title());
        po.setBriefText(conversation.briefText());
        po.setBriefSource(BriefSource.dbOf(conversation.briefSource()));
        po.setBriefUpdatedAt(Times.ofMs(conversation.briefUpdatedAtMs()));
        po.setSyncedSequence(conversation.syncedSequence());
        po.setNativeSessionId(conversation.nativeSessionId());
        po.setCreatedAt(Times.ofMs(conversation.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(conversation.updatedAtMs()));
        return po;
    }

    static Conversation toConversation(ConversationPO po) {
        return new Conversation(
                po.getConversationId(),
                po.getWorkspaceId(),
                po.getProjectId(),
                po.getOwnerUserId(),
                po.getDeviceId(),
                po.getAgentConfigId(),
                po.getTaskId(),
                ConversationStatus.codeOf(po.getStatus()),
                po.getTitle(),
                po.getBriefText(),
                BriefSource.codeOf(po.getBriefSource()),
                Times.ms(po.getBriefUpdatedAt()),
                po.getSyncedSequence(),
                po.getNativeSessionId(),
                Times.ms(po.getCreatedAt()),
                Times.ms(po.getUpdatedAt())
        );
    }
}
