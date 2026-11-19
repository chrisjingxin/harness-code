package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.OrgPO;

/**
 * 模块：机构表数据访问映射接口 (OrgMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_org 表的机构档案读写能力。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface OrgMapper extends BaseMapper<OrgPO> {}
