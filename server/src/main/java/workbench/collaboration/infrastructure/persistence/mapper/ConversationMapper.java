package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.ConversationPO;

/**
 * 模块：会话表数据访问映射接口 (ConversationMapper)
 *
 * <p>【功能定义】
 * 继承 MyBatis-Plus 基础 BaseMapper，提供对 wb_conversation 表的标准 CRUD 与条件查询能力。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 框架。
 */
@Mapper
public interface ConversationMapper extends BaseMapper<ConversationPO> {}
