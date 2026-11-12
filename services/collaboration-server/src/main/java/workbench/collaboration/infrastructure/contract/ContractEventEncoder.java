package workbench.collaboration.infrastructure.contract;

import org.springframework.stereotype.Component;
import workbench.collaboration.application.port.EventEncoder;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.execution.ExecutionState;
import workbench.collaboration.interfaces.dto.ConversationDtos;

import java.util.UUID;

/**
 * 模块：符合 Schema 规范的事件编码器实现 (ContractEventEncoder)
 *
 * <p>【功能定义】
 * 实现 EventEncoder 接口，在事件写入热滑窗及对外广播之前，
 * 统一将其组装为符合平台 ConversationEvent Schema 的标准 JSON 报文。
 * 确保 SSE 实时流、Kafka 事件广播与客户端离线补齐统一消费同一串确定性字节。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService。
 * - 下游依赖方：Contracts、TimeCodec、ConversationDtos。
 */
@Component
public final class ContractEventEncoder implements EventEncoder {

    private final Contracts contracts;

    public ContractEventEncoder(Contracts contracts) {
        this.contracts = contracts;
    }

    @Override
    public String conversationCreated(Conversation conversation, long sequence, long occurredAtMs) {
        var summary = summary(conversation);
        return contracts.encode("ConversationEvent", event(
                "conversation.created",
                conversation.workspaceId(),
                conversation.id(),
                sequence,
                occurredAtMs,
                new ConversationDtos.ConversationPayload(summary)
        ));
    }

    @Override
    public String messageCreated(Message message, String workspaceId, long sequence, long occurredAtMs) {
        Object author = "agent".equals(message.authorKind())
                ? new ConversationDtos.AgentAuthor("agent", message.agentConfigId())
                : new ConversationDtos.UserAuthor("user", message.authorUserId(), message.authorUsername(), message.authorDisplayName());
        var wire = new ConversationDtos.Message(
                message.messageId(),
                message.conversationId(),
                message.executionId(),
                author,
                Long.toString(message.sequence()),
                TimeCodec.utc(message.createdAtMs()),
                message.text(),
                message.state()
        );
        return contracts.encode("ConversationEvent", event(
                "message.created",
                workspaceId,
                message.conversationId(),
                sequence,
                occurredAtMs,
                new ConversationDtos.MessagePayload(wire)
        ));
    }

    @Override
    public String executionChanged(String workspaceId, ExecutionState state, long sequence, long occurredAtMs) {
        return contracts.encode("ConversationEvent", event(
                "execution.changed",
                workspaceId,
                state.conversationId(),
                sequence,
                occurredAtMs,
                new ConversationDtos.ExecutionPayload(view(state))
        ));
    }

    public ConversationDtos.ExecutionView view(ExecutionState state) {
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

    public ConversationDtos.ConversationSummary summary(Conversation conversation) {
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

    private static ConversationDtos.ConversationEvent event(
            String type,
            String workspaceId,
            String conversationId,
            long sequence,
            long occurredAtMs,
            Object payload
    ) {
        return new ConversationDtos.ConversationEvent(
                1,
                UUID.randomUUID().toString(),
                type,
                TimeCodec.utc(occurredAtMs),
                workspaceId,
                conversationId,
                Long.toString(sequence),
                payload
        );
    }
}
