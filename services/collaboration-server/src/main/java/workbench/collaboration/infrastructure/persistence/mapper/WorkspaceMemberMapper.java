package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.WorkspaceMemberPO;

/**
 * 模块：工作区成员表数据访问映射接口 (WorkspaceMemberMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_workspace_member 成员关联表的查询。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface WorkspaceMemberMapper extends BaseMapper<WorkspaceMemberPO> {}
