package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.persistence.mapper.RepositoryMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：团队仓库目录仓储持久化实现 (RepositoryCatalogImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现对 TDSQL 表 wb_repository 的持久化。
 * (workspace_id, remote_url) 唯一约束交给数据库兜底；
 * 更新走 UpdateWrapper 显式列集，避免 MyBatis-Plus 默认跳 null。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryAppService、ProjectAccessPolicy。
 * - 下游依赖方：RepositoryMapper、RepositoryConverter。
 */
@org.springframework.stereotype.Repository
public class RepositoryCatalogImpl implements RepositoryCatalog {

    private final RepositoryMapper repositories;

    public RepositoryCatalogImpl(RepositoryMapper repositories) {
        this.repositories = repositories;
    }

    @Override
    public Optional<Repository> findById(String id) {
        return Optional.ofNullable(repositories.selectOne(new QueryWrapper<RepositoryPO>().eq("repository_id", id)))
                .map(RepositoryConverter::toRepository);
    }

    @Override
    public void insert(Repository repository) {
        if (repositories.insert(RepositoryConverter.toPo(repository)) != 1) {
            throw new IllegalStateException("仓库目录条目没有写入");
        }
    }

    @Override
    public void update(Repository repository) {
        int rows = repositories.update(null, new UpdateWrapper<RepositoryPO>()
                .eq("repository_id", repository.id())
                .set("name", repository.name())
                .set("default_branch", repository.defaultBranch())
                .set("status", repository.status().db())
                .set("updated_at", Times.ofMs(repository.updatedAtMs())));
        if (rows != 1) {
            throw new IllegalStateException("仓库目录条目不存在");
        }
    }

    @Override
    public List<Repository> listByWorkspace(String workspaceId, RepositoryStatus status) {
        QueryWrapper<RepositoryPO> query = new QueryWrapper<RepositoryPO>().eq("workspace_id", workspaceId);
        if (status != null) {
            query.eq("status", status.db());
        }
        query.orderByAsc("name").orderByAsc("id");
        return repositories.selectList(query).stream()
                .map(RepositoryConverter::toRepository)
                .toList();
    }
}
