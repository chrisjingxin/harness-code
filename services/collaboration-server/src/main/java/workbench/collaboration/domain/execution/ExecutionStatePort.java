package workbench.collaboration.domain.execution;

import java.util.Optional;

/**
 * 模块：执行状态与防重端口接口 (ExecutionStatePort)
 *
 * <p>【功能定义】
 * 定义活跃执行热状态的缓存读写，以及对来自 Electron Daemon 上报事件的序号与指纹去重契约。
 * 防止网络抖动、重试引发的数据重复提交与参数篡改。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService、DeviceAppService。
 * - 下游实现方：infrastructure/cache/JedisCollaborationState、infrastructure/cache/MemoryExecutionState。
 */
public interface ExecutionStatePort {

    /**
     * 持久化或刷新活跃执行的热状态（通常存储在 Redis，附带 TTL 超时）。
     *
     * @param state 活跃执行状态实体
     */
    void save(ExecutionState state);

    /**
     * 查询指定执行任务的当前热状态快照。
     *
     * @param executionId 执行唯一标识
     * @return 存在时返回包含 ExecutionState 的 Optional，否则返回 Optional.empty()
     */
    Optional<ExecutionState> find(String executionId);

    /**
     * 校验并记录来自端侧上报的事件序号与内容指纹。
     *
     * <p>【防重放与防篡改动机 (Why)】
     * - 首次到达（First Seen）：序号未被消费，记录指纹并返回 true；
     * - 重复到达（Replay）：序号已存在且指纹完全一致，属于安全重试，直接跳过并返回 false；
     * - 非法篡改（Tampered）：序号已被占用但指纹不一致，表明同一序号被发送了不同内容，
     *   必须抛出 IllegalStateException 拒绝处理，确保审计与状态严格一致。
     *
     * @param executionId 执行唯一标识
     * @param sequence 端侧产生的本地事件连续序号
     * @param fingerprint 事件载荷计算出的 SHA-256 唯一内容指纹
     * @return true 表示序号初次到达需正常处理；false 表示幂等重放需安全忽略
     * @throws IllegalStateException 当检测到同一序号上报了不同指纹时抛出
     */
    boolean rememberSource(String executionId, long sequence, String fingerprint);
}
