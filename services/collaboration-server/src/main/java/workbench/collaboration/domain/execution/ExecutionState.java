package workbench.collaboration.domain.execution;

/**
 * 模块：活跃执行热状态模型 (ExecutionState)
 *
 * <p>【功能定义】
 * 描述一次任务执行（Execution）生命周期内的实时热态快照。
 * 遵循存算分离设计：活跃执行状态保存在 Redis（wb:execution:{executionId}），
 * 承接取消请求仲裁、当前状态轮询与执行结果同步，不写入 TDSQL 产生单表爆炸。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService、DeviceAppService、ExecutionStatePort。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param executionId 执行唯一业务标识 (UUID)
 * @param conversationId 所属会话标识
 * @param inputId 触发本执行的用户输入消息标识
 * @param inputSequence 输入消息在会话中的连续序号
 * @param initiatedByUserId 触发本次执行的用户标识
 * @param state 当前执行生命周期状态（见 ExecutionStateMachine）
 * @param lastConfirmedState 客户端 Daemon 最近一次确认的状态
 * @param cancelState 当前取消控制状态（如 "none"、"requested"、"confirmed"）
 * @param reasonCode 失败或取消原因编码
 * @param createdAtMs 执行创建时间戳（毫秒）
 * @param updatedAtMs 最近一次状态流转时间戳（毫秒）
 * @param commandFingerprint 触发指令的 SHA-256 唯一指纹（用于幂等防篡改比对）
 */
public record ExecutionState(
        String executionId,
        String conversationId,
        String inputId,
        long inputSequence,
        String initiatedByUserId,
        String state,
        String lastConfirmedState,
        String cancelState,
        String reasonCode,
        long createdAtMs,
        long updatedAtMs,
        String commandFingerprint
) {}
