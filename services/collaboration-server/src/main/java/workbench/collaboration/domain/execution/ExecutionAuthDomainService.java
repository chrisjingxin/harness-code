package workbench.collaboration.domain.execution;

/**
 * 模块：执行授权领域服务 (ExecutionAuthDomainService)
 *
 * <p>【功能定义】
 * 提供对向 Electron 本机设备派发 Agent 任务的纯领域级准入校验。
 * 遵循高可用安全原则：仅当目标代码项目已被所有者开放共享，
 * 且会话请求的智能体配置在项目的合法可用清单中时，才允许发起派发。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService。
 * - 下游依赖方：纯领域逻辑，无外部系统依赖。
 */
public final class ExecutionAuthDomainService {

    private ExecutionAuthDomainService() {}

    /**
     * 判断当前执行是否允许被派发到目标设备上运行。
     *
     * @param shareEnabled 项目当前的共享开关状态（true 表示允许共享协作）
     * @param configAvailable 请求的 Agent 运行配置是否已被项目授权开放
     * @return 双方同时满足时返回 true，否则拒绝执行返回 false
     */
    public static boolean canStart(boolean shareEnabled, boolean configAvailable) {
        return shareEnabled && configAvailable;
    }
}
