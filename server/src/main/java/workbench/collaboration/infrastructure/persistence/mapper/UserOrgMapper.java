package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.UserOrgPO;

/**
 * 模块：用户机构关系表数据访问映射接口 (UserOrgMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_user_org 表的用户岗位关系读写能力。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface UserOrgMapper extends BaseMapper<UserOrgPO> {}
