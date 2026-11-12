package workbench.collaboration.domain.device;

/**
 * 模块：共享项目实体模型 (SharedProject)
 *
 * <p>【功能定义】
 * 表示指定 Electron Daemon 设备向工作区其他成员开放协作访问的代码项目。
 * 包含共享开关状态、乐观锁版本号以及该项目支持的 Agent 配置列表元数据。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、ExecutionAppService、DeviceRepository。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param workspaceId 所属工作区标识
 * @param deviceId 持有该代码工程的物理设备标识
 * @param projectId 工作区内唯一的项目业务标识
 * @param name 项目可读名称
 * @param shareEnabled 是否已开启跨设备共享访问（false 时拒绝外部发起新执行）
 * @param shareVersion 乐观锁版本号（每次变更共享状态自增，用于 CAS 并发防护）
 * @param agentConfigsJson 当前项目支持的 ACP Agent 配置集合（JSON 格式字符串）
 * @param updatedAtMs 最近一次更新配置的时间戳（毫秒）
 */
public record SharedProject(
        String workspaceId,
        String deviceId,
        String projectId,
        String name,
        boolean shareEnabled,
        long shareVersion,
        String agentConfigsJson,
        long updatedAtMs
) {}
