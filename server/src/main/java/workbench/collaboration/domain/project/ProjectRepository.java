package workbench.collaboration.domain.project;

import java.util.List;
import java.util.Optional;

/**
 * 模块：项目聚合仓储端口接口 (ProjectRepository)
 *
 * <p>【功能定义】
 * 定义对 wb_project、wb_project_member、wb_project_repository 三张表的持久化访问契约。
 * 项目行经 CAS（updateIfVersion）推进版本；成员资格用 upsert 保留 removed 历史；
 * 仓库引用以存在性查询支撑会话登记的"引用子集"校验。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAppService、ProjectAccessPolicy、ConversationSyncAppService。
 * - 下游实现方：infrastructure/persistence/ProjectRepositoryImpl。
 */
public interface ProjectRepository {

    /**
     * 根据项目业务标识查询项目（无锁读）。
     */
    Optional<Project> findById(String id);

    /**
     * 新增项目记录（初始 version=1）。
     */
    void insert(Project project);

    /**
     * 乐观并发更新：仅当库内 version 等于 expectedVersion 时写入新版本（version+1）。
     *
     * <p>【并发控制动机 (Why)】
     * 负责人并发 PATCH 同一项目时，后提交者必须感知前序修改而非静默覆盖；
     * 返回 false 由调用方转译为 409 VERSION_CONFLICT。
     *
     * @param project 带新版本字段的项目实体（version 字段取值不参与 WHERE）
     * @param expectedVersion 调用方读取时见到的版本号
     * @return 更新命中返回 true；版本已被他人推进返回 false
     */
    boolean updateIfVersion(Project project, long expectedVersion);

    /**
     * 列出某团队内指定用户以 active 成员身份参与的全部项目。
     */
    List<Project> listForMember(String workspaceId, String userId);

    /**
     * 查询某用户在某项目中的成员记录（active 与 removed 均返回）。
     */
    Optional<ProjectMember> findMember(String projectId, String userId);

    /**
     * 列出项目全部成员记录（active + removed，供成员页"已离开"标注）。
     */
    List<ProjectMember> listMembers(String projectId);

    /**
     * 幂等写入成员记录：不存在则插入，存在则更新 status 与 updated_at（保留原 created_at）。
     */
    void upsertMember(ProjectMember member);

    /**
     * 统计项目内指定状态的成员数量（memberCount 展示用）。
     */
    int countMembers(String projectId, MemberStatus status);

    /**
     * 判断项目是否已引用指定仓库（会话登记"仓库 ⊆ 项目引用"校验用）。
     */
    boolean referenceExists(String projectId, String repositoryId);

    /**
     * 新增一条项目仓库引用（uk(project_id, repository_id) 兜底幂等）。
     */
    void insertReference(ProjectRepositoryRef reference);

    /**
     * 删除一条项目仓库引用。
     *
     * @return 实际删除行数；0 表示引用不存在（调用方转 404）
     */
    int deleteReference(String projectId, String repositoryId);

    /**
     * 列出项目引用的全部仓库关联。
     */
    List<ProjectRepositoryRef> listReferences(String projectId);

    /**
     * 列出引用了指定仓库的全部项目关联（仓库详情"引用它的项目"用）。
     */
    List<ProjectRepositoryRef> listReferencesByRepository(String repositoryId);
}
