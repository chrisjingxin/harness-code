package workbench.collaboration.domain.execution;

import java.util.Map;
import java.util.Set;

/**
 * 模块：执行生命周期状态机 (ExecutionStateMachine)
 *
 * <p>【功能定义】
 * 定义协作执行任务（Execution）的合法状态集合与单向流转转移边。
 * 核心不变量：状态流转严格遵循有向无环原则，终态（Terminal States）不可逆转，
 * 绝不允许从终态被重新唤醒、派发或篡改为排队状态。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService、DeviceAppService。
 * - 下游依赖方：纯领域逻辑，无外部系统依赖。
 *
 * <p>【执行生命周期状态流转图】
 * <pre>
 *                     ┌─────────────┐
 *                     │   queued    │ (入队待派发)
 *                     └──────┬──────┘
 *             ┌──────────────┼──────────────┐
 *             ▼              ▼              ▼
 *       [rejected]      [cancelled]   ┌─────────────┐
 *        (已拒绝)        (已取消)      │ dispatching │ (派发中)
 *                                     └──────┬──────┘
 *             ┌──────────────┬───────────────┴──────────────┐
 *             ▼              ▼                              ▼
 *         [failed]      [cancelled]                   ┌─────────────┐
 *          (失败)         (已取消)                     │  accepted   │ (端侧已接单)
 *                                                     └──────┬──────┘
 *                                      ┌─────────────────────┼─────────────────────┐
 *                                      ▼                     ▼                     ▼
 *                                  [failed]             [cancelled]          ┌─────────────┐
 *                                   (失败)                (已取消)            │   running   │ (执行中)
 *                                                                            └──────┬──────┘
 *                                      ┌─────────────────────┬─────────────────────┼─────────────────────┐
 *                                      ▼                     ▼                     ▼                     ▼
 *                                 [succeeded]            [failed]             [cancelled]           ┌─────────────┐
 *                                  (执行成功)              (失败)               (已取消)             │   unknown   │ (失联超时)
 *                                                                                                   └──────┬──────┘
 *                                                                       ┌──────────────────────────────────┴──────┐
 *                                                                       ▼                                         ▼
 *                                                             [succeeded/failed/cancelled]                    │ running │
 * </pre>
 */
public final class ExecutionStateMachine {

    /**
     * 合法状态流转邻接表（Key: 源状态 -> Value: 允许跃迁的目标状态集合）。
     */
    private static final Map<String, Set<String>> EDGES = Map.of(
            "queued", Set.of("dispatching", "cancelled", "rejected"),
            "dispatching", Set.of("accepted", "unknown", "cancelled", "failed"),
            "accepted", Set.of("running", "cancelled", "failed"),
            "running", Set.of("succeeded", "failed", "cancelled", "unknown"),
            "unknown", Set.of("running", "succeeded", "failed", "cancelled")
    );

    private ExecutionStateMachine() {}

    /**
     * 判断指定状态是否为不可逆的终结状态 (Terminal State)。
     *
     * @param state 状态字符串
     * @return 若是 succeeded / failed / cancelled / rejected 则返回 true，否则返回 false
     */
    public static boolean terminal(String state) {
        return Set.of("succeeded", "failed", "cancelled", "rejected").contains(state);
    }

    /**
     * 校验从源状态到目标状态的状态变迁是否合法。
     *
     * <p>【状态不变量防护 (Invariants)】
     * - 源状态或目标状态为空，直接拒绝；
     * - 源状态与目标状态相同（自循环），视为无效流转直接拒绝；
     * - 源状态不存在于邻接表（如已是终态），或者目标状态不在允许集合内，拒绝流转。
     *
     * @param from 源状态字符串
     * @param to 目标状态字符串
     * @return 合法流转返回 true，非法跳跃返回 false
     */
    public static boolean legal(String from, String to) {
        if (from == null || to == null || from.equals(to)) {
            return false;
        }
        return EDGES.getOrDefault(from, Set.of()).contains(to);
    }
}
