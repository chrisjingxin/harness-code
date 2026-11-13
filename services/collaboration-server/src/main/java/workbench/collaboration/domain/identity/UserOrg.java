package workbench.collaboration.domain.identity;

/**
 * 模块：用户与机构关系领域实体 (UserOrg)
 *
 * <p>【功能定义】
 * 记录用户在组织架构中的岗位归属（主岗/兼岗）与有效状态，支撑一人多岗扩展与机构信息关联。
 * 归属于 identity 界限上下文。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepository、Foundation。
 * - 下游依赖方：持久化映射到 wb_user_org 表。
 */
public record UserOrg(
        String userId,
        int positionType,
        String orgId,
        String orgNo,
        String orgName,
        String orgPathId,
        String orgPathNo,
        String orgPathName,
        int status,
        long createdAtMs,
        long updatedAtMs
) {
    public UserOrg {
        orgPathId = orgPathId == null ? "" : orgPathId;
        orgPathNo = orgPathNo == null ? "" : orgPathNo;
        orgPathName = orgPathName == null ? "" : orgPathName;
    }
}
