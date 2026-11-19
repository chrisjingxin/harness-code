package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.RepositoryPO;

/**
 * 模块：团队仓库目录表数据访问映射接口 (RepositoryMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_repository 表的持久化查询。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryCatalogImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface RepositoryMapper extends BaseMapper<RepositoryPO> {}
