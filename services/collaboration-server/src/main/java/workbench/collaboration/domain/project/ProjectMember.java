package workbench.collaboration.domain.project;

/**
 * 模块：项目成员关联实体 (ProjectMember)
 *
 * <p>【功能定义】
 * 表示一名团队用户在某项目中的成员资格。
 * 移出成员只翻转 status 为 removed、不删行（D9）：保留审计事实，
 * removed 记录带 updated_at 供看板标注"已离开项目"。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAccessPolicy、ProjectAppService、ProjectConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param projectId 所属项目标识
 * @param userId 成员用户标识
 * @param status 成员状态（active/removed）
 * @param createdAtMs 首次加入时间戳（毫秒，upsert 回 active 时保留原值）
 * @param updatedAtMs 状态最近变更时间戳（毫秒）
 */
public record ProjectMember(
        String projectId,
        String userId,
        MemberStatus status,
        long createdAtMs,
        long updatedAtMs
) {}
