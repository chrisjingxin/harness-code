package workbench.collaboration.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import workbench.collaboration.infrastructure.persistence.ConversationRepoRefPO;

/**
 * 会话涉及仓库关联表 MyBatis 映射（基础 CRUD 由 MyBatis-Plus 提供）。
 */
@Mapper
public interface ConversationRepoRefMapper extends BaseMapper<ConversationRepoRefPO> {}
