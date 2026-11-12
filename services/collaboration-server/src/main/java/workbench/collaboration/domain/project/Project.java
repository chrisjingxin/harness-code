package workbench.collaboration.domain.project;

/**
 * 模块：业务项目实体模型 (Project)
 *
 * <p>【功能定义】
 * 表示团队内一个多人协作的业务项目：它引用若干团队仓库（wb_project_repository），
 * 拥有成员清单（wb_project_member），是会话、任务、快照等协作资源的归属边界。
 * version 为乐观并发版本：写路径经 CAS（version = expectedVersion）推进，
 * 防并发负责人同时改同一项目时互相覆盖。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAppService、ProjectAccessPolicy、ProjectConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param id 项目全局唯一标识 (UUID)
 * @param workspaceId 所属团队标识
 * @param name 项目显示名（1~80 字符）
 * @param description 项目说明（≤2000 字符）
 * @param ownerUserId 项目负责人（创建者，可移交前固定）
 * @param status 项目状态（active/archived）
 * @param version 乐观并发版本号，创建为 1，每次成功 CAS 写入 +1
 * @param createdAtMs 创建时间戳（毫秒）
 * @param updatedAtMs 最近修改时间戳（毫秒）
 */
public record Project(
        String id,
        String workspaceId,
        String name,
        String description,
        String ownerUserId,
        ProjectStatus status,
        long version,
        long createdAtMs,
        long updatedAtMs
) {}
