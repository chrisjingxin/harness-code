package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.device.SharedProject;
import workbench.collaboration.infrastructure.persistence.mapper.DeviceMapper;
import workbench.collaboration.infrastructure.persistence.mapper.DeviceProjectMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：设备与共享项目仓储持久化实现 (DeviceRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现对 TDSQL 表 wb_device 与 wb_device_project 的持久化。
 * 领域实体与底层自增主键 pk_id 严格隔离，所有查询与更新均按业务唯一标识进行。
 * 支持 CAS 乐观锁版本比对（updateProjectIfVersion），保证并发更新共享配置时的版本严格一致。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService。
 * - 下游依赖方：DeviceMapper、DeviceProjectMapper、DeviceConverter。
 */
@Repository
public class DeviceRepositoryImpl implements DeviceRepository {

    private final DeviceMapper devices;
    private final DeviceProjectMapper projects;

    public DeviceRepositoryImpl(DeviceMapper devices, DeviceProjectMapper projects) {
        this.devices = devices;
        this.projects = projects;
    }

    @Override
    public Optional<Device> findById(String id) {
        return Optional.ofNullable(devices.selectOne(new QueryWrapper<DevicePO>().eq("id", id)))
                .map(DeviceConverter::toDevice);
    }

    @Override
    public void insert(Device device) {
        if (devices.insert(DeviceConverter.toPo(device)) != 1) {
            throw new IllegalStateException("设备没有写入");
        }
    }

    @Override
    public void update(Device device) {
        DevicePO po = DeviceConverter.toPo(device);
        int rows = devices.update(po, new UpdateWrapper<DevicePO>().eq("id", device.id()));
        if (rows != 1) {
            throw new IllegalStateException("设备不存在");
        }
    }

    @Override
    public List<Device> listByWorkspace(String workspaceId, Long beforeCreatedAtMs, String beforeId, int limit) {
        QueryWrapper<DevicePO> query = new QueryWrapper<DevicePO>().eq("workspace_id", workspaceId);
        if (beforeCreatedAtMs != null && beforeId != null) {
            query.and(wrapper -> wrapper.lt("created_at_ms", beforeCreatedAtMs)
                    .or(inner -> inner.eq("created_at_ms", beforeCreatedAtMs).lt("id", beforeId)));
        }
        query.orderByDesc("created_at_ms").orderByDesc("id").last("LIMIT " + limit);
        return devices.selectList(query).stream()
                .map(DeviceConverter::toDevice)
                .toList();
    }

    @Override
    public Optional<SharedProject> findProject(String workspaceId, String projectId) {
        DeviceProjectPO po = projects.selectOne(new QueryWrapper<DeviceProjectPO>()
                .eq("workspace_id", workspaceId)
                .eq("project_id", projectId));
        return Optional.ofNullable(po).map(DeviceConverter::toProject);
    }

    @Override
    public void insertProject(SharedProject project) {
        if (projects.insert(DeviceConverter.toPo(project)) != 1) {
            throw new IllegalStateException("共享项目没有写入");
        }
    }

    @Override
    public void updateProject(SharedProject project) {
        DeviceProjectPO po = DeviceConverter.toPo(project);
        int rows = projects.update(po, new UpdateWrapper<DeviceProjectPO>()
                .eq("workspace_id", project.workspaceId())
                .eq("project_id", project.projectId()));
        if (rows != 1) {
            throw new IllegalStateException("共享项目不存在");
        }
    }

    @Override
    public boolean updateProjectIfVersion(SharedProject project, long expectedVersion) {
        DeviceProjectPO po = DeviceConverter.toPo(project);
        // CAS 乐观锁并发防护：仅当数据库当前 share_version 等于调用方期待的版本 expectedVersion 时才生效
        int rows = projects.update(po, new UpdateWrapper<DeviceProjectPO>()
                .eq("workspace_id", project.workspaceId())
                .eq("project_id", project.projectId())
                .eq("share_version", expectedVersion));
        return rows == 1;
    }

    @Override
    public List<SharedProject> listProjects(String workspaceId, String deviceId, Long beforeUpdatedAtMs, String beforeProjectId, int limit) {
        QueryWrapper<DeviceProjectPO> query = new QueryWrapper<DeviceProjectPO>()
                .eq("workspace_id", workspaceId)
                .eq("device_id", deviceId);
        // 共享项目游标以 updated_at_ms 为基准
        if (beforeUpdatedAtMs != null && beforeProjectId != null) {
            query.and(wrapper -> wrapper.lt("updated_at_ms", beforeUpdatedAtMs)
                    .or(inner -> inner.eq("updated_at_ms", beforeUpdatedAtMs).lt("project_id", beforeProjectId)));
        }
        query.orderByDesc("updated_at_ms").orderByDesc("project_id").last("LIMIT " + limit);
        return projects.selectList(query).stream()
                .map(DeviceConverter::toProject)
                .toList();
    }
}
