package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.identity.Org;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.UserOrg;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;

/**
 * 模块：用户、机构与工作区持久化对象与领域模型转换器 (IdentityConverter)
 *
 * <p>【功能定义】
 * 提供 User、Org、UserOrg、Workspace、WorkspaceMember 领域实体与对应 PO 之间的双向字段映射。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepositoryImpl。
 * - 下游依赖方：User、Org、UserOrg、Workspace、WorkspaceMember、PO 类。
 */
final class IdentityConverter {

    private IdentityConverter() {}

    static UserPO toPo(User user) {
        UserPO po = new UserPO();
        po.setUserId(user.id());
        po.setUserNo(user.userNo());
        po.setUserName(user.userName());
        po.setPhoto(user.photo());
        po.setOrgId(user.orgId());
        po.setOrgNo(user.orgNo());
        po.setOrgName(user.orgName());
        po.setOrgPathId(user.orgPathId());
        po.setOrgPathNo(user.orgPathNo());
        po.setOrgPathName(user.orgPathName());
        po.setEnabled(user.enabled() ? 1 : 0);
        po.setCreatedAt(Times.ofMs(user.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(user.updatedAtMs()));
        return po;
    }

    static User toUser(UserPO po) {
        return new User(
                po.getUserId(),
                po.getUserNo(),
                po.getUserName(),
                po.getPhoto(),
                po.getOrgId(),
                po.getOrgNo(),
                po.getOrgName(),
                po.getOrgPathId(),
                po.getOrgPathNo(),
                po.getOrgPathName(),
                Integer.valueOf(1).equals(po.getEnabled()),
                Times.ms(po.getCreatedAt()),
                Times.ms(po.getUpdatedAt())
        );
    }

    static OrgPO toPo(Org org) {
        OrgPO po = new OrgPO();
        po.setOrgId(org.orgId());
        po.setOrgNo(org.orgNo());
        po.setOrgName(org.orgName());
        po.setParentOrgId(org.parentOrgId());
        po.setParentOrgNo(org.parentOrgNo());
        po.setParentOrgName(org.parentOrgName());
        po.setPathId(org.pathId());
        po.setPathNo(org.pathNo());
        po.setPathName(org.pathName());
        po.setIsLeaf(org.leaf() ? 1 : 0);
        po.setCreatedAt(Times.ofMs(org.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(org.updatedAtMs()));
        return po;
    }

    static Org toOrg(OrgPO po) {
        return new Org(
                po.getOrgId(),
                po.getOrgNo(),
                po.getOrgName(),
                po.getParentOrgId(),
                po.getParentOrgNo(),
                po.getParentOrgName(),
                po.getPathId(),
                po.getPathNo(),
                po.getPathName(),
                Integer.valueOf(1).equals(po.getIsLeaf()),
                Times.ms(po.getCreatedAt()),
                Times.ms(po.getUpdatedAt())
        );
    }

    static UserOrgPO toPo(UserOrg userOrg) {
        UserOrgPO po = new UserOrgPO();
        po.setUserId(userOrg.userId());
        po.setPositionType(userOrg.positionType());
        po.setOrgId(userOrg.orgId());
        po.setOrgNo(userOrg.orgNo());
        po.setOrgName(userOrg.orgName());
        po.setOrgPathId(userOrg.orgPathId());
        po.setOrgPathNo(userOrg.orgPathNo());
        po.setOrgPathName(userOrg.orgPathName());
        po.setStatus(userOrg.status());
        po.setCreatedAt(Times.ofMs(userOrg.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(userOrg.updatedAtMs()));
        return po;
    }

    static WorkspacePO toPo(Workspace workspace) {
        WorkspacePO po = new WorkspacePO();
        po.setWorkspaceId(workspace.id());
        po.setSlug(workspace.slug());
        po.setName(workspace.name());
        po.setCreatedAt(Times.ofMs(workspace.createdAtMs()));
        return po;
    }

    static Workspace toWorkspace(WorkspacePO po) {
        return new Workspace(
                po.getWorkspaceId(),
                po.getSlug(),
                po.getName(),
                Times.ms(po.getCreatedAt())
        );
    }

    static WorkspaceMemberPO toPo(WorkspaceMember member) {
        WorkspaceMemberPO po = new WorkspaceMemberPO();
        po.setWorkspaceId(member.workspaceId());
        po.setUserId(member.userId());
        po.setCreatedAt(Times.ofMs(member.createdAtMs()));
        return po;
    }
}
