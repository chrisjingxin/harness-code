package workbench.collaboration.domain.repository;

/**
 * 模块：团队仓库目录实体 (Repository)
 *
 * <p>【功能定义】
 * 表示团队级仓库目录（wb_repository）中的一条登记：
 * 远端 Git 地址是团队内唯一键，项目是"引用"目录条目而非独占。
 * 本地绝对路径属于各设备隐私，绝不进入本表。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryAppService、ProjectAccessPolicy、RepositoryConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param id 仓库全局唯一标识 (UUID)
 * @param workspaceId 所属团队标识
 * @param name 目录显示名（1~120 字符）
 * @param remoteUrl 远端仓库地址（1~512 字符，团队内唯一）
 * @param defaultBranch 默认分支名（≤128 字符）
 * @param status 目录状态（active/archived）
 * @param createdByUserId 登记者用户标识
 * @param createdAtMs 登记时间戳（毫秒）
 * @param updatedAtMs 最近修改时间戳（毫秒）
 */
public record Repository(
        String id,
        String workspaceId,
        String name,
        String remoteUrl,
        String defaultBranch,
        RepositoryStatus status,
        String createdByUserId,
        long createdAtMs,
        long updatedAtMs
) {}
