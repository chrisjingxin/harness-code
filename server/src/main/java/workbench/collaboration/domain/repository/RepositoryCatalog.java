package workbench.collaboration.domain.repository;

import java.util.List;
import java.util.Optional;

/**
 * 模块：团队仓库目录仓储端口接口 (RepositoryCatalog)
 *
 * <p>【功能定义】
 * 定义对 TDSQL 表 wb_repository（团队级仓库目录）的持久化访问契约。
 * (workspace_id, remote_url) 唯一约束由数据库兜底，调用方把
 * DuplicateKeyException 转译为 409 REPOSITORY_CONFLICT。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryAppService、ProjectAccessPolicy。
 * - 下游实现方：infrastructure/persistence/RepositoryCatalogImpl。
 */
public interface RepositoryCatalog {

    /**
     * 根据仓库业务标识查询目录条目。
     */
    Optional<Repository> findById(String id);

    /**
     * 新增一条目录登记（remote_url 冲突由数据库唯一键抛出）。
     */
    void insert(Repository repository);

    /**
     * 更新目录条目（重命名、默认分支、归档翻转）。
     */
    void update(Repository repository);

    /**
     * 按团队列出目录条目。
     *
     * @param workspaceId 团队标识
     * @param status 状态过滤；传 null 表示返回全部（active + archived）
     */
    List<Repository> listByWorkspace(String workspaceId, RepositoryStatus status);
}
