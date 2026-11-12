package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.DaemonCommandPort;
import workbench.collaboration.domain.execution.ExecutionState;
import workbench.collaboration.infrastructure.contract.ExecutionCodec;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.dto.ExecutionDtos;

import java.util.UUID;

/**
 * 模块：执行指令分发应用服务 (ExecutionAppService)
 *
 * <p>【功能定义】
 * 负责构建符合跨语言协议标准的执行启动命令（ExecutionStartMessage）与序列化 JSON 报文，
 * 并通过 DaemonCommandPort 路由分发给目标物理设备。
 * 遵循非阻塞容错原则：若目标设备当前未建立 WebSocket 连接，指令会被安全丢弃，执行热状态保持排队，
 * 绝不阻塞调用方线程或长事务。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService。
 * - 下游依赖方：DaemonCommandPort、ExecutionCodec、TimeCodec、ExecutionDtos。
 */
@Service
public class ExecutionAppService {

    private final DaemonCommandPort commands;
    private final ExecutionCodec codec = new ExecutionCodec();

    public ExecutionAppService(DaemonCommandPort commands) {
        this.commands = commands;
    }

    /**
     * 将指令分发至目标设备。
     *
     * @param deviceId 目标 Electron Daemon 设备标识
     * @param commandJson 指令封包 JSON 字符串
     */
    public void dispatch(String deviceId, String commandJson) {
        commands.dispatch(deviceId, commandJson);
    }

    /**
     * 构建带有确定性封包签名校验的执行启动消息对象。
     *
     * <p>【安全指纹机制 (Why)】
     * 通过 ExecutionCodec.seal 计算规范化载荷哈希，确保下发到 Electron 本机的指令防篡改、参数确定。
     *
     * @param conversation 所属会话聚合根
     * @param executionId 执行流水唯一标识
     * @param inputId 触发本执行的用户输入标识
     * @param inputSequence 输入消息在会话中的连续序号
     * @param initiatedByUserId 触发该任务的用户标识
     * @param createdAtMs 创建时间戳（毫秒）
     * @param text 提问正文内容
     * @param shareVersion 当前项目共享版本号
     * @return 签名完毕的 ExecutionStartMessage 消息实体
     */
    public ExecutionDtos.ExecutionStartMessage createStart(
            Conversation conversation,
            String executionId,
            String inputId,
            long inputSequence,
            String initiatedByUserId,
            long createdAtMs,
            String text,
            long shareVersion
    ) {
        var payload = new ExecutionDtos.ExecutionStartPayload(
                conversation.workspaceId(),
                conversation.id(),
                executionId,
                inputId,
                conversation.deviceId(),
                conversation.projectId(),
                Long.toString(inputSequence),
                initiatedByUserId,
                conversation.agentConfigId(),
                Long.toString(shareVersion),
                conversation.nativeSessionId(),
                new ExecutionDtos.ExecutionInput(text),
                "0".repeat(64)
        );
        var message = new ExecutionDtos.ExecutionStartMessage(
                1,
                UUID.randomUUID().toString(),
                "execution.start",
                TimeCodec.utc(createdAtMs),
                payload
        );
        return codec.seal(message, ExecutionDtos.ExecutionStartMessage.class);
    }

    /**
     * 生成供下发至目标设备 WebSocket 管道的启动指令 JSON 字符串。
     *
     * @param conversation 会话实体
     * @param state 活跃执行热状态
     * @param text 提问正文
     * @param shareVersion 共享版本号
     * @return 序列化 JSON 指令字符串
     */
    public String startCommand(Conversation conversation, ExecutionState state, String text, long shareVersion) {
        return codec.json(createStart(
                conversation,
                state.executionId(),
                state.inputId(),
                state.inputSequence(),
                state.initiatedByUserId(),
                state.createdAtMs(),
                text,
                shareVersion
        ));
    }

    /**
     * 将对象格式化为跨端兼容的 JSON 字符串。
     *
     * @param message 待转换对象
     * @return JSON 字符串
     */
    public String json(Object message) {
        return codec.json(message);
    }
}
