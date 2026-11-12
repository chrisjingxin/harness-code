package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.repository.LocalRepoBinding;
import workbench.collaboration.domain.repository.LocalRepoBindingRepository;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.interfaces.ApiProblem;

/**
 * 模块：设备本机仓库登记应用服务 (RepoBindingAppService)
 *
 * <p>【功能定义】
 * 承载"这台设备上有这个仓库的本机克隆"这一事实的登记与解除。
 * 这是设备凭据域路由：调用方以 Bearer 设备凭据认证，服务只记录
 * (deviceId, repositoryId) 关联——本机绝对路径绝不上行（D8），
 * 请求体不接受任何字段（带体请求在边界即被拒）。
 *
 * <p>【安全原则 (Why)】
 * - 仓库已归档 → 409 REPOSITORY_ARCHIVED，不再接受新登记；
 * - 设备 owner 不是仓库所属团队成员 → 403 DEVICE_FORBIDDEN；
 * - (deviceId, repositoryId) 重复 PUT 为幂等 upsert；DELETE 未命中 → 404。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceRepoBindingController。
 * - 下游依赖方：DeviceAppService（凭据认证）、RepositoryCatalog、
 *   LocalRepoBindingRepository、ProjectAccessPolicy。
 */
@Service
public class RepoBindingAppService {

    private final DeviceAppService devices;
    private final RepositoryCatalog repositories;
    private final LocalRepoBindingRepository bindings;
    private final ProjectAccessPolicy policy;

    public RepoBindingAppService(
            DeviceAppService devices,
            RepositoryCatalog repositories,
            LocalRepoBindingRepository bindings,
            ProjectAccessPolicy policy
    ) {
        this.devices = devices;
        this.repositories = repositories;
        this.bindings = bindings;
        this.policy = policy;
    }

    /**
     * 登记本机仓库克隆（幂等 upsert）。
     *
     * @param authorization Bearer 设备凭据头
     * @param repositoryId 团队仓库目录条目标识
     */
    @Transactional
    public void bind(String authorization, String repositoryId) {
        Device device = devices.authenticate(authorization);
        Repository repository = repositories.findById(repositoryId)
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        if (repository.status() == RepositoryStatus.ARCHIVED) {
            throw new ApiProblem(409, "REPOSITORY_ARCHIVED");
        }
        policy.requireBindingAuthority(device, repository);
        bindings.upsert(new LocalRepoBinding(device.id(), repositoryId, System.currentTimeMillis()));
    }

    /**
     * 解除本机仓库登记。未登记过 → 404（DELETE 只对存在资源幂等）。
     */
    @Transactional
    public void unbind(String authorization, String repositoryId) {
        Device device = devices.authenticate(authorization);
        if (bindings.delete(device.id(), repositoryId) == 0) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
    }
}
