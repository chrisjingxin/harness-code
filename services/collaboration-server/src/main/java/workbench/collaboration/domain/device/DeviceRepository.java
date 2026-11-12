package workbench.collaboration.domain.device;

import java.util.List;
import java.util.Optional;

/**
 * 模块：设备仓储端口接口 (DeviceRepository)
 *
 * <p>【功能定义】
 * 定义对 TDSQL 中设备档案表（wb_device）的持久化访问契约。
 * 设备属于用户本人：列表查询按 owner_user_id 维度进行，与工作区解耦。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、ConversationSyncAppService。
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
     * 按所有者游标分页列出设备列表（按创建时间倒序）。
     *
     * @param ownerUserId 设备所有者用户标识
     * @param beforeCreatedAtMs 游标时间戳（毫秒）
     * @param beforeId 游标辅助标识
     * @param limit 本次查询的最大条数
     * @return 设备列表
     */
    List<Device> listByOwner(String ownerUserId, Long beforeCreatedAtMs, String beforeId, int limit);
}
