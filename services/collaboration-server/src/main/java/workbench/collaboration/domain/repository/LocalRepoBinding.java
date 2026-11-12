package workbench.collaboration.domain.repository;

/**
 * 模块：设备本机仓库登记实体 (LocalRepoBinding)
 *
 * <p>【功能定义】
 * 表示"某台设备在本机克隆了目录中的某个仓库"（wb_local_repo_binding）。
 * 只存 device_id + repository_id 的关联事实——本地绝对路径只存本机，
 * 不上云（隐私边界，D3/D11）。
 *
 * <p>【协作边界】
 * - 上游调用方：RepoBindingAppService、LocalRepoBindingRepository、RepositoryConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param deviceId 登记设备标识
 * @param repositoryId 团队仓库目录条目标识
 * @param createdAtMs 最近一次登记时间戳（毫秒，重复 upsert 时刷新）
 */
public record LocalRepoBinding(
        String deviceId,
        String repositoryId,
        long createdAtMs
) {}
