package workbench.collaboration.domain.identity;

/**
 * 模块：用户实体模型 (User)
 *
 * <p>【功能定义】
 * 表示协作工作台中的可登录人类用户账号及当前生效组织档案。
 * 遵循领域建模原则：底层 TDSQL 表的物理聚簇自增主键（id）仅供底层分页优化使用，
 * 在领域模型与外部契约中统一使用全局业务标识 (UUID)。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityAppService、IdentityRepository、IdentityConverter、WebSecurityConfig。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param id 用户全局唯一业务标识 (UUID)
 * @param userNo 员工工号/一号通标识（如 80278667，未绑定为空串）
 * @param userName 用户名称（如 沈北辰）
 * @param photo 用户头像 URL（未设置为空串）
 * @param orgId 所属内部机构 ID
 * @param orgNo 所属外部机构 ID
 * @param orgName 所属机构名称
 * @param orgPathId 内部机构路径 ID
 * @param orgPathNo 外部机构路径 ID
 * @param orgPathName 机构路径名称
 * @param enabled 账号启用状态（false 表示已被禁用，拒绝登录与交互）
 * @param createdAtMs 账号创建时间戳（毫秒）
 * @param updatedAtMs 账号最近更新时间戳（毫秒）
 */
public record User(
        String id,
        String userNo,
        String userName,
        String photo,
        String orgId,
        String orgNo,
        String orgName,
        String orgPathId,
        String orgPathNo,
        String orgPathName,
        boolean enabled,
        long createdAtMs,
        long updatedAtMs
) {
    public User {
        userNo = userNo == null ? "" : userNo;
        photo = photo == null ? "" : photo;
        orgId = orgId == null ? "" : orgId;
        orgNo = orgNo == null ? "" : orgNo;
        orgName = orgName == null ? "" : orgName;
        orgPathId = orgPathId == null ? "" : orgPathId;
        orgPathNo = orgPathNo == null ? "" : orgPathNo;
        orgPathName = orgPathName == null ? "" : orgPathName;
    }
}
