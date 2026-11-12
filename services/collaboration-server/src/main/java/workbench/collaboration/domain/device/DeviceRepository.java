package workbench.collaboration.domain.device;

import java.util.List;
import java.util.Optional;

/**
 * 模块：设备与共享项目仓储端口接口 (DeviceRepository)
 *
 * <p>【功能定义】
 * 定义对 TDSQL 中设备档案表（wb_device）与共享项目表（wb_device_project）的持久化访问契约。
 * 提供设备档案维护、工作区设备列表分页，以及支持 CAS 乐观锁并发保护的共享项目读写能力。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、ExecutionAppService。
 * - 下游实现方：infrastructure/persistence/DeviceRepositoryImpl。
 */
public interface DeviceRepository {

    /**
     * 根据设备标识查询设备档案。
     *
     * @param id 设备标识
     * @return 存在时返回包含 Device 的 Optional，否则返回 Optional.empty()
     */
    Optional<Device> findById(String id);

    /**
     * 新增设备档案。
     *
     * @param device 待插入的设备实体
     */
    void insert(Device device);

    /**
     * 更新设备档案状态（如重命名、吊销禁用）。
     *
     * @param device 待更新的设备实体
     */
    void update(Device device);

    /**
     * 按工作区游标分页列出设备列表（按创建时间倒序）。
     *
     * @param workspaceId 所属工作区标识
     * @param beforeCreatedAtMs 游标时间戳（毫秒）
     * @param beforeId 游标辅助标识
     * @param limit 本次查询的最大条数
     * @return 设备列表
     */
    List<Device> listByWorkspace(String workspaceId, Long beforeCreatedAtMs, String beforeId, int limit);

    /**
     * 查询指定工作区下的共享项目。
     *
     * @param workspaceId 所属工作区标识
     * @param projectId 项目唯一标识
     * @return 存在时返回包含 SharedProject 的 Optional，否则返回 Optional.empty()
     */
    Optional<SharedProject> findProject(String workspaceId, String projectId);

    /**
     * 新增共享项目配置。
     *
     * @param project 共享项目实体
     */
    void insertProject(SharedProject project);

    /**
     * 全量更新共享项目配置（无版本比对）。
     *
     * @param project 共享项目实体
     */
    void updateProject(SharedProject project);

    /**
     * 基于 CAS（Compare-And-Swap）乐观锁版本比对更新共享项目。
     *
     * <p>【并发控制动机 (Why)】
     * 当多名管理员或端侧客户端并发修改共享设置（例如同时开启/关闭共享）时，
     * 必须校验期待的 shareVersion，防止无序覆盖产生脏数据。
     * 只有当前数据库版本等于 expectedVersion 时才执行更新并将版本号自增。
     *
     * @param project 待更新的共享项目实体
     * @param expectedVersion 调用方当前期望的项目共享版本号
     * @return 更新成功（行数=1）返回 true，版本已被他人修改（行数=0）返回 false
     */
    boolean updateProjectIfVersion(SharedProject project, long expectedVersion);

    /**
     * 按工作区与设备分页列出共享项目列表。
     *
     * @param workspaceId 所属工作区标识
     * @param deviceId 设备标识
     * @param beforeUpdatedAtMs 游标时间戳（毫秒）
     * @param beforeProjectId 游标项目标识
     * @param limit 本次查询的最大条数
     * @return 共享项目列表
     */
    List<SharedProject> listProjects(String workspaceId, String deviceId, Long beforeUpdatedAtMs, String beforeProjectId, int limit);
}
