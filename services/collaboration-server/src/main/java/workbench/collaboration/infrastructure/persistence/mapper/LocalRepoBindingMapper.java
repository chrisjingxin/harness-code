package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.LocalRepoBindingPO;

/**
 * 模块：设备本机仓库登记表数据访问映射接口 (LocalRepoBindingMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_local_repo_binding 表的持久化查询。
 * upsert 走数据库 ON DUPLICATE KEY 原子语义：重复登记只刷新登记时间戳。
 *
 * <p>【协作边界】
 * - 上游调用方：LocalRepoBindingRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface LocalRepoBindingMapper extends BaseMapper<LocalRepoBindingPO> {

    /**
     * 幂等写入登记：唯一键冲突时刷新 created_at（最近一次登记时间）。
     */
    @Insert("INSERT INTO wb_local_repo_binding (device_id, repository_id, created_at)"
            + " VALUES (#{deviceId}, #{repositoryId}, #{createdAt})"
            + " ON DUPLICATE KEY UPDATE created_at = VALUES(created_at)")
    int upsert(LocalRepoBindingPO po);
}
