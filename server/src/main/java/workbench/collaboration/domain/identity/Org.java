package workbench.collaboration.domain.identity;

/**
 * 模块：机构组织领域实体 (Org)
 *
 * <p>【功能定义】
 * 描述一号通同步的组织架构节点，包含内外部机构标识、父级关联、层级路径与叶子节点标记。
 * 归属于 identity 界限上下文。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepository、Foundation。
 * - 下游依赖方：持久化映射到 wb_org 表。
 */
public record Org(
        String orgId,
        String orgNo,
        String orgName,
        String parentOrgId,
        String parentOrgNo,
        String parentOrgName,
        String pathId,
        String pathNo,
        String pathName,
        boolean leaf,
        long createdAtMs,
        long updatedAtMs
) {
    public Org {
        parentOrgId = parentOrgId == null ? "" : parentOrgId;
        parentOrgNo = parentOrgNo == null ? "" : parentOrgNo;
        parentOrgName = parentOrgName == null ? "" : parentOrgName;
        pathId = pathId == null ? "" : pathId;
        pathNo = pathNo == null ? "" : pathNo;
        pathName = pathName == null ? "" : pathName;
    }
}
