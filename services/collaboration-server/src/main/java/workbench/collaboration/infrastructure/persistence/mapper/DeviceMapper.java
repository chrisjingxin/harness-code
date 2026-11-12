package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.DevicePO;

/**
 * 模块：设备档案表数据访问映射接口 (DeviceMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_device 表的档案持久化查询。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface DeviceMapper extends BaseMapper<DevicePO> {}
