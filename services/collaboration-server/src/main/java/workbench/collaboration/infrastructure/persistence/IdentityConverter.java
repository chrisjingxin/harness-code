package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;

/**
 * 模块：用户与工作区持久化对象与领域模型转换器 (IdentityConverter)
 *
 * <p>【功能定义】
 * 提供 User、Workspace、WorkspaceMember 领域实体与 UserPO、WorkspacePO、WorkspaceMemberPO 之间的双向字段映射。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepositoryImpl。
 * - 下游依赖方：User、Workspace、WorkspaceMember、PO 类。
 */
final class IdentityConverter {

    private IdentityConverter() {}

    static UserPO toPo(User user) {
        UserPO po = new UserPO();
        po.setId(user.id());
        po.setUsername(user.username());
        po.setDisplayName(user.displayName());
        po.setEnabled(user.enabled() ? 1 : 0);
        po.setCreatedAt(Times.ofMs(user.createdAtMs()));
        return po;
    }

    static User toUser(UserPO po) {
        return new User(
                po.getId(),
                po.getUsername(),
                po.getDisplayName(),
                Integer.valueOf(1).equals(po.getEnabled()),
                Times.ms(po.getCreatedAt())
        );
    }

    static WorkspacePO toPo(Workspace workspace) {
        WorkspacePO po = new WorkspacePO();
        po.setId(workspace.id());
        po.setSlug(workspace.slug());
        po.setName(workspace.name());
        po.setCreatedAt(Times.ofMs(workspace.createdAtMs()));
        return po;
    }

    static Workspace toWorkspace(WorkspacePO po) {
        return new Workspace(
                po.getId(),
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
