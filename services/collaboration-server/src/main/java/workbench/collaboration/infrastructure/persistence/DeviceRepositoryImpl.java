package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.infrastructure.persistence.mapper.DeviceMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：设备仓储持久化实现 (DeviceRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现对 TDSQL 表 wb_device 的持久化。
 * 领域实体与底层自增主键 pk_id 严格隔离，所有查询与更新均按业务唯一标识进行。
 * 设备列表按 owner_user_id 维度分页（设备属人，与工作区无关）。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService。
 * - 下游依赖方：DeviceMapper、DeviceConverter。
 */
@Repository
public class DeviceRepositoryImpl implements DeviceRepository {

    private final DeviceMapper devices;

    public DeviceRepositoryImpl(DeviceMapper devices) {
        this.devices = devices;
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
    public List<Device> listByOwner(String ownerUserId, Long beforeCreatedAtMs, String beforeId, int limit) {
        QueryWrapper<DevicePO> query = new QueryWrapper<DevicePO>().eq("owner_user_id", ownerUserId);
        if (beforeCreatedAtMs != null && beforeId != null) {
            query.and(wrapper -> wrapper.lt("created_at", Times.ofMs(beforeCreatedAtMs))
                    .or(inner -> inner.eq("created_at", Times.ofMs(beforeCreatedAtMs)).lt("id", beforeId)));
        }
        query.orderByDesc("created_at").orderByDesc("id").last("LIMIT " + limit);
        return devices.selectList(query).stream()
                .map(DeviceConverter::toDevice)
                .toList();
    }
}
