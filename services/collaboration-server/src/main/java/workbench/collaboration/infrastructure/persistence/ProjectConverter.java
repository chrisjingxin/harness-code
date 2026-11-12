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
        po.setStatus(project.status().db());
        po.setVersion(project.version());
        po.setCreatedAt(Times.ofMs(project.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(project.updatedAtMs()));
        return po;
    }

    static Project toProject(ProjectPO po) {
        return new Project(
                po.getId(),
                po.getWorkspaceId(),
                po.getName(),
                po.getDescription(),
                po.getOwnerUserId(),
                ProjectStatus.fromDb(po.getStatus()),
                po.getVersion(),
                Times.ms(po.getCreatedAt()),
                Times.ms(po.getUpdatedAt())
        );
    }

    static ProjectMemberPO toPo(ProjectMember member) {
        ProjectMemberPO po = new ProjectMemberPO();
        po.setProjectId(member.projectId());
        po.setUserId(member.userId());
        po.setStatus(member.status().db());
        po.setCreatedAt(Times.ofMs(member.createdAtMs()));
        po.setUpdatedAt(Times.ofMs(member.updatedAtMs()));
        return po;
    }

    static ProjectMember toMember(ProjectMemberPO po) {
        return new ProjectMember(
                po.getProjectId(),
                po.getUserId(),
                MemberStatus.fromDb(po.getStatus()),
                Times.ms(po.getCreatedAt()),
                Times.ms(po.getUpdatedAt())
        );
    }

    static ProjectRepositoryRefPO toPo(ProjectRepositoryRef reference) {
        ProjectRepositoryRefPO po = new ProjectRepositoryRefPO();
        po.setProjectId(reference.projectId());
        po.setRepositoryId(reference.repositoryId());
        po.setCreatedAt(Times.ofMs(reference.createdAtMs()));
        return po;
    }

    static ProjectRepositoryRef toReference(ProjectRepositoryRefPO po) {
        return new ProjectRepositoryRef(po.getProjectId(), po.getRepositoryId(), Times.ms(po.getCreatedAt()));
    }
}
