package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.infrastructure.persistence.mapper.ConversationMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：会话表仓储持久化实现 (ConversationRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现对 TDSQL 表 wb_conversation 的持久化读写。
 * 遵循高可用协作原则：
 * 1. 悲观行锁防并发（lockById）：通过 SQL 尾部追加 FOR UPDATE 锁定当前行，防止并发序号竞争；
 * 2. 游标分页排序保序：基于 (created_at_ms, id) 联合降序排列，彻底避免深分页深度扫描与数据漏读；
 * 3. 显式列更新置空保护：针对 activeExecutionId 与 nativeSessionId 允许被清空的业务场景，
 *    通过 UpdateWrapper 显式 set 字段，覆盖 MyBatis-Plus 默认跳过 null 值的行为。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService。
 * - 下游依赖方：ConversationMapper、ConversationConverter。
 */
@Repository
public class ConversationRepositoryImpl implements ConversationRepository {

    private final ConversationMapper conversations;

    public ConversationRepositoryImpl(ConversationMapper conversations) {
        this.conversations = conversations;
    }

    @Override
    public Optional<Conversation> findById(String id) {
        return Optional.ofNullable(conversations.selectOne(new QueryWrapper<ConversationPO>().eq("id", id)))
                .map(ConversationConverter::toConversation);
    }

    @Override
    public Optional<Conversation> lockById(String id) {
        // 行级悲观锁：锁定会话记录行，必须处于外部短事务内
        return Optional.ofNullable(conversations.selectOne(new QueryWrapper<ConversationPO>().eq("id", id).last("FOR UPDATE")))
                .map(ConversationConverter::toConversation);
    }

    @Override
    public List<Conversation> list(String workspaceId, Long beforeCreatedAtMs, String beforeId, int limit) {
        QueryWrapper<ConversationPO> query = new QueryWrapper<ConversationPO>().eq("workspace_id", workspaceId);
        // 游标过滤条件：(created_at_ms < beforeCreatedAtMs) OR (created_at_ms = beforeCreatedAtMs AND id < beforeId)
        if (beforeCreatedAtMs != null && beforeId != null) {
            query.and(wrapper -> wrapper.lt("created_at_ms", beforeCreatedAtMs)
                    .or(inner -> inner.eq("created_at_ms", beforeCreatedAtMs).lt("id", beforeId)));
        }
        query.orderByDesc("created_at_ms").orderByDesc("id").last("LIMIT " + limit);
        return conversations.selectList(query).stream()
                .map(ConversationConverter::toConversation)
                .toList();
    }

    @Override
    public void insert(Conversation conversation) {
        if (conversations.insert(ConversationConverter.toPo(conversation)) != 1) {
            throw new IllegalStateException("会话没有写入");
        }
    }

    @Override
    public void update(Conversation conversation) {
        // 架构防护动机 (Why)：MyBatis-Plus 实体更新默认会忽略值为 null 的属性；
        // 但会话终态或空闲时必须将 activeExecutionId 与 nativeSessionId 显式置空，因此使用 UpdateWrapper 显式 set
        int rows = conversations.update(null, new UpdateWrapper<ConversationPO>()
                .eq("id", conversation.id())
                .set("workspace_id", conversation.workspaceId())
                .set("title", conversation.title())
                .set("created_by_user_id", conversation.createdByUserId())
                .set("current_user_id", conversation.currentUserId())
                .set("device_id", conversation.deviceId())
                .set("project_id", conversation.projectId())
                .set("agent_config_id", conversation.agentConfigId())
                .set("next_sequence", conversation.nextSequence())
                .set("native_session_id", conversation.nativeSessionId())
                .set("active_execution_id", conversation.activeExecutionId())
                .set("updated_at_ms", conversation.updatedAtMs()));
        if (rows != 1) {
            throw new IllegalStateException("会话不存在");
        }
    }
}
