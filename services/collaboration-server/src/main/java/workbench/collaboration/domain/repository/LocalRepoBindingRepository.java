package workbench.collaboration.domain.repository;

import java.util.List;

/**
 * 模块：设备本机仓库登记仓储端口接口 (LocalRepoBindingRepository)
 *
 * <p>【功能定义】
 * 定义对 TDSQL 表 wb_local_repo_binding（设备 × 团队仓库）的持久化访问契约。
 * 登记幂等：同一 (device_id, repository_id) 重复 upsert 不产生重复行。
 *
 * <p>【协作边界】
 * - 上游调用方：RepoBindingAppService、ProjectAppService（clonedDevices 展示）。
 * - 下游实现方：infrastructure/persistence/LocalRepoBindingRepositoryImpl。
 */
public interface LocalRepoBindingRepository {

    /**
     * 幂等写入登记：不存在则插入，已存在则刷新登记时间戳。
     */
    void upsert(LocalRepoBinding binding);

    /**
     * 删除一条登记。
     *
     * @return 实际删除行数；0 表示登记不存在（调用方转 404）
     */
    int delete(String deviceId, String repositoryId);

    /**
     * 判断某设备是否已登记某仓库。
     */
    boolean exists(String deviceId, String repositoryId);

    /**
     * 列出某设备登记的全部仓库关联（设备视角）。
     */
    List<LocalRepoBinding> listByDevice(String deviceId);

    /**
     * 列出登记了某仓库的全部设备关联（clonedDevices 展示用）。
     */
    List<LocalRepoBinding> listByRepository(String repositoryId);
}
