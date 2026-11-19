package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.ProjectPO;

/**
 * 模块：业务项目表数据访问映射接口 (ProjectMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_project 表的持久化查询。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface ProjectMapper extends BaseMapper<ProjectPO> {}
