package workbench.collaboration.domain.execution;

/**
 * 模块：序号递增运算工具 (SequenceNumbers)
 *
 * <p>【功能定义】
 * 提供对协作会话连续序号（nextSequence）的安全步进计算。
 * 会话头中的 nextSequence 标识下一条待分配的事件序号基准水位。
 * 当单次复合操作（例如同时写入输入消息与执行产生事件）需连续占用多个序号时，
 * 通过本工具预先计算出占用后的全新基准水位。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、ExecutionAppService。
 * - 下游依赖方：纯领域逻辑，无框架注解。
 */
public final class SequenceNumbers {

    private SequenceNumbers() {}

    /**
     * 计算预分配 count 个连续序号之后的新水位基准。
     *
     * <p>【入参校验与防御 (Invariants)】
     * - nextSequence 必须 >= 1，序号严禁从 0 或负数起始；
     * - count 必须 >= 1，步进步长必须至少为 1。
     *
     * @param nextSequence 当前会话头中记录的下一可用序号
     * @param count 本次操作需连续占用的序号数量
     * @return 预占用后的新序号起始基准 (nextSequence + count)
     * @throws IllegalArgumentException 当序号或步长小于 1 时抛出
     */
    public static long advance(long nextSequence, int count) {
        if (nextSequence < 1 || count < 1) {
            throw new IllegalArgumentException("序号无效");
        }
        return nextSequence + count;
    }
}
