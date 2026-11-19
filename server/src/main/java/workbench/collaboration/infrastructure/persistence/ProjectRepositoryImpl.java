package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.infrastructure.persistence.mapper.ProjectMapper;
import workbench.collaboration.infrastructure.persistence.mapper.ProjectMemberMapper;
import workbench.collaboration.infrastructure.persistence.mapper.ProjectRepositoryRefMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：项目聚合仓储持久化实现 (ProjectRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现 wb_project / wb_project_member / wb_project_repository 三张表的持久化。
 * 关键并发语义：
 * 1. updateIfVersion 走"WHERE id=? AND version=?"的条件更新——版本被他人推进时命中 0 行返回 false；
 * 2. upsertMember 走数据库 ON DUPLICATE KEY 原子语义，并发加人/踢人不产生竞态窗口；
 * 3. 成员移出不删行（D9），仅由应用层翻转 status 后走 upsert。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAppService、ProjectAccessPolicy、ConversationSyncAppService。
 * - 下游依赖方：ProjectMapper、ProjectMemberMapper、ProjectRepositoryRefMapper、ProjectConverter。
 */
@Repository
public class ProjectRepositoryImpl implements ProjectRepository {

    private final ProjectMapper projects;
    private final ProjectMemberMapper members;
    private final ProjectRepositoryRefMapper references;

    public ProjectRepositoryImpl(ProjectMapper projects, ProjectMemberMapper members, ProjectRepositoryRefMapper references) {
        this.projects = projects;
        this.members = members;
        this.references = references;
    }

    @Override
    public Optional<Project> findById(String id) {
        return Optional.ofNullable(projects.selectOne(new QueryWrapper<ProjectPO>().eq("project_id", id)))
                .map(ProjectConverter::toProject);
    }

    @Override
    public void insert(Project project) {
        if (projects.insert(ProjectConverter.toPo(project)) != 1) {
            throw new IllegalStateException("项目没有写入");
        }
    }

    @Override
    public boolean updateIfVersion(Project project, long expectedVersion) {
        // CAS 乐观锁：版本号已被并发请求推进时命中 0 行，调用方转 409 VERSION_CONFLICT
        return projects.update(null, new UpdateWrapper<ProjectPO>()
                .eq("project_id", project.id())
                .eq("version", expectedVersion)
                .set("name", project.name())
                .set("description", project.description())
                .set("status", project.status().db())
                .setSql("version = version + 1")
                .set("updated_at", Times.ofMs(project.updatedAtMs()))) == 1;
    }

    @Override
    public List<Project> listForMember(String workspaceId, String userId) {
        List<String> projectIds = members.selectList(new QueryWrapper<ProjectMemberPO>()
                        .eq("user_id", userId)
                        .eq("status", MemberStatus.ACTIVE.db()))
                .stream().map(ProjectMemberPO::getProjectId).toList();
        if (projectIds.isEmpty()) {
            return List.of();
        }
        return projects.selectList(new QueryWrapper<ProjectPO>()
                        .eq("workspace_id", workspaceId)
                        .in("project_id", projectIds)
                        .orderByDesc("updated_at").orderByDesc("id"))
                .stream().map(ProjectConverter::toProject).toList();
    }

    @Override
    public Optional<ProjectMember> findMember(String projectId, String userId) {
        return Optional.ofNullable(members.selectOne(new QueryWrapper<ProjectMemberPO>()
                        .eq("project_id", projectId)
                        .eq("user_id", userId)))
                .map(ProjectConverter::toMember);
    }

    @Override
    public List<ProjectMember> listMembers(String projectId) {
        return members.selectList(new QueryWrapper<ProjectMemberPO>()
                        .eq("project_id", projectId)
                        .orderByAsc("created_at").orderByAsc("user_id"))
                .stream().map(ProjectConverter::toMember).toList();
    }

    @Override
    public void upsertMember(ProjectMember member) {
        members.upsert(ProjectConverter.toPo(member));
    }

    @Override
    public int countMembers(String projectId, MemberStatus status) {
        return Math.toIntExact(members.selectCount(new QueryWrapper<ProjectMemberPO>()
                .eq("project_id", projectId)
                .eq("status", status.db())));
    }

    @Override
    public boolean referenceExists(String projectId, String repositoryId) {
        return references.selectCount(new QueryWrapper<ProjectRepositoryRefPO>()
                .eq("project_id", projectId)
                .eq("repository_id", repositoryId)) > 0;
    }

    @Override
    public void insertReference(ProjectRepositoryRef reference) {
        if (references.insert(ProjectConverter.toPo(reference)) != 1) {
            throw new IllegalStateException("项目仓库引用没有写入");
        }
    }

    @Override
    public int deleteReference(String projectId, String repositoryId) {
        return references.delete(new QueryWrapper<ProjectRepositoryRefPO>()
                .eq("project_id", projectId)
                .eq("repository_id", repositoryId));
    }

    @Override
    public List<ProjectRepositoryRef> listReferences(String projectId) {
        return references.selectList(new QueryWrapper<ProjectRepositoryRefPO>()
                        .eq("project_id", projectId)
                        .orderByAsc("created_at").orderByAsc("repository_id"))
                .stream().map(ProjectConverter::toReference).toList();
    }

    @Override
    public List<ProjectRepositoryRef> listReferencesByRepository(String repositoryId) {
        return references.selectList(new QueryWrapper<ProjectRepositoryRefPO>()
                        .eq("repository_id", repositoryId))
                .stream().map(ProjectConverter::toReference).toList();
    }
}
