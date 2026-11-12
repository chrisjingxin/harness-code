package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.project.ProjectStatus;

/**
 * 模块：项目聚合持久化对象与领域模型转换器 (ProjectConverter)
 *
 * <p>【功能定义】
 * 提供 Project / ProjectMember / ProjectRepositoryRef 领域实体与对应 PO 之间的双向转换。
 * status 列与枚举互转；未知枚举值在读取侧直接抛错（数据完整性哨兵）。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectRepositoryImpl。
 * - 下游依赖方：domain/project 实体与各 PO。
 */
final class ProjectConverter {

    private ProjectConverter() {}

    static ProjectPO toPo(Project project) {
        ProjectPO po = new ProjectPO();
        po.setId(project.id());
        po.setWorkspaceId(project.workspaceId());
        po.setName(project.name());
        po.setDescription(project.description());
        po.setOwnerUserId(project.ownerUserId());
        po.setStatus(project.status().code());
        po.setVersion(project.version());
        po.setCreatedAtMs(project.createdAtMs());
        po.setUpdatedAtMs(project.updatedAtMs());
        return po;
    }

    static Project toProject(ProjectPO po) {
        return new Project(
                po.getId(),
                po.getWorkspaceId(),
                po.getName(),
                po.getDescription(),
                po.getOwnerUserId(),
                ProjectStatus.fromCode(po.getStatus()),
                po.getVersion(),
                po.getCreatedAtMs(),
                po.getUpdatedAtMs()
        );
    }

    static ProjectMemberPO toPo(ProjectMember member) {
        ProjectMemberPO po = new ProjectMemberPO();
        po.setProjectId(member.projectId());
        po.setUserId(member.userId());
        po.setStatus(member.status().code());
        po.setCreatedAtMs(member.createdAtMs());
        po.setUpdatedAtMs(member.updatedAtMs());
        return po;
    }

    static ProjectMember toMember(ProjectMemberPO po) {
        return new ProjectMember(
                po.getProjectId(),
                po.getUserId(),
                MemberStatus.fromCode(po.getStatus()),
                po.getCreatedAtMs(),
                po.getUpdatedAtMs()
        );
    }

    static ProjectRepositoryRefPO toPo(ProjectRepositoryRef reference) {
        ProjectRepositoryRefPO po = new ProjectRepositoryRefPO();
        po.setProjectId(reference.projectId());
        po.setRepositoryId(reference.repositoryId());
        po.setCreatedAtMs(reference.createdAtMs());
        return po;
    }

    static ProjectRepositoryRef toReference(ProjectRepositoryRefPO po) {
        return new ProjectRepositoryRef(po.getProjectId(), po.getRepositoryId(), po.getCreatedAtMs());
    }
}
