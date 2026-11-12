package workbench.collaboration.domain.identity;

/**
 * 模块：用户实体模型 (User)
 *
 * <p>【功能定义】
 * 表示协作工作台中的可登录人类用户账号。
 * 遵循领域建模原则：底层 TDSQL 表的物理聚簇自增主键（id）仅供底层分页优化使用，
 * 在领域模型与外部契约中统一使用全局业务标识 (UUID)。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityAppService、IdentityRepository、IdentityConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param id 用户全局唯一业务标识 (UUID)
 * @param username 登录用户名
 * @param displayName 用户对外展示的人类可读名称
 * @param enabled 账号启用状态（false 表示已被禁用，拒绝登录与交互）
 * @param createdAtMs 账号创建时间戳（毫秒）
 */
public record User(
        String id,
        String username,
        String displayName,
        boolean enabled,
        long createdAtMs
) {}
