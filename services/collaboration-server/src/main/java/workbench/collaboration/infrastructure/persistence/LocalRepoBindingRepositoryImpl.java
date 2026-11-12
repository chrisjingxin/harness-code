package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.repository.LocalRepoBinding;
import workbench.collaboration.domain.repository.LocalRepoBindingRepository;
import workbench.collaboration.infrastructure.persistence.mapper.LocalRepoBindingMapper;

import java.util.List;

/**
 * 模块：设备本机仓库登记仓储持久化实现 (LocalRepoBindingRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现对 TDSQL 表 wb_local_repo_binding 的持久化。
 * 登记幂等交给数据库 ON DUPLICATE KEY 原子语义，重复登记只刷新时间戳。
 *
 * <p>【协作边界】
 * - 上游调用方：RepoBindingAppService、ProjectAppService。
 * - 下游依赖方：LocalRepoBindingMapper、RepositoryConverter。
 */
@Repository
public class LocalRepoBindingRepositoryImpl implements LocalRepoBindingRepository {

    private final LocalRepoBindingMapper bindings;

    public LocalRepoBindingRepositoryImpl(LocalRepoBindingMapper bindings) {
        this.bindings = bindings;
    }

    @Override
    public void upsert(LocalRepoBinding binding) {
        bindings.upsert(RepositoryConverter.toPo(binding));
    }

    @Override
    public int delete(String deviceId, String repositoryId) {
        return bindings.delete(new QueryWrapper<LocalRepoBindingPO>()
                .eq("device_id", deviceId)
                .eq("repository_id", repositoryId));
    }

    @Override
    public boolean exists(String deviceId, String repositoryId) {
        return bindings.selectCount(new QueryWrapper<LocalRepoBindingPO>()
                .eq("device_id", deviceId)
                .eq("repository_id", repositoryId)) > 0;
    }

    @Override
    public List<LocalRepoBinding> listByDevice(String deviceId) {
        return bindings.selectList(new QueryWrapper<LocalRepoBindingPO>().eq("device_id", deviceId))
                .stream().map(RepositoryConverter::toBinding).toList();
    }

    @Override
    public List<LocalRepoBinding> listByRepository(String repositoryId) {
        return bindings.selectList(new QueryWrapper<LocalRepoBindingPO>().eq("repository_id", repositoryId))
                .stream().map(RepositoryConverter::toBinding).toList();
    }
}
