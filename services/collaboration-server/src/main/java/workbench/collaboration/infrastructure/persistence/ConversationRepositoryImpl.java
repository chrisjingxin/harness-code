package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.conversation.BriefSource;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.ConversationStatus;
import workbench.collaboration.infrastructure.persistence.mapper.ConversationMapper;
import workbench.collaboration.infrastructure.persistence.mapper.ConversationRepoRefMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：会话表仓储持久化实现 (ConversationRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 实现对 TDSQL 表 wb_conversation 的持久化读写。
 * 遵循高可用协作原则：
 * 1. 悲观行锁防并发（lockById）：同步推进 synced_sequence 水位时通过 FOR UPDATE 锁行，防止水位互相覆盖；
 * 2. 游标分页排序保序：项目内会话按 (updated_at, id) 联合降序排列，避免深分页漏读；
 * 3. 显式列更新：task_id/agent_config_id/brief/native_session_id 以 '' 空串表达未绑定，
 *    通过 UpdateWrapper 显式 set 覆盖 MyBatis-Plus 默认跳过 null 值的行为。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService。
 * - 下游依赖方：ConversationMapper、ConversationConverter。
 */
@Repository
public class ConversationRepositoryImpl implements ConversationRepository {

    private final ConversationMapper conversations;
    private final ConversationRepoRefMapper refs;

    public ConversationRepositoryImpl(ConversationMapper conversations, ConversationRepoRefMapper refs) {
        this.conversations = conversations;
        this.refs = refs;
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
    public List<Conversation> listByProject(String projectId, String ownerId, String status, int limit) {
        QueryWrapper<ConversationPO> query = new QueryWrapper<ConversationPO>().eq("project_id", projectId);
        if (ownerId != null) {
            query.eq("owner_user_id", ownerId);
        }
        if (status != null) {
            query.eq("status", ConversationStatus.dbOf(status));
        }
        query.orderByDesc("updated_at").orderByDesc("id").last("LIMIT " + limit);
        return conversations.selectList(query).stream()
                .map(ConversationConverter::toConversation)
                .toList();
    }

    @Override
    public void insertRepositoryRefs(String conversationId, List<String> repositoryIds, long createdAtMs) {
        for (String repositoryId : repositoryIds) {
            ConversationRepoRefPO po = new ConversationRepoRefPO();
            po.setConversationId(conversationId);
            po.setRepositoryId(repositoryId);
            po.setCreatedAt(Times.ofMs(createdAtMs));
            // (conversation_id, repository_id) 唯一键兜底去重，重复登记幂等
            if (refs.insert(po) != 1) {
                throw new IllegalStateException("会话仓库关联没有写入");
            }
        }
    }

    @Override
    public List<String> listRepositoryIds(String conversationId) {
        return refs.selectList(new QueryWrapper<ConversationRepoRefPO>().eq("conversation_id", conversationId))
                .stream()
                .map(ConversationRepoRefPO::getRepositoryId)
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
        // 架构防护动机 (Why)：MyBatis-Plus 实体更新默认忽略 null 属性；
        // 任务解绑、简报清空等场景必须显式写 '' 哨兵，因此使用 UpdateWrapper 显式 set
        int rows = conversations.update(null, new UpdateWrapper<ConversationPO>()
                .eq("id", conversation.id())
                .set("workspace_id", conversation.workspaceId())
                .set("project_id", conversation.projectId())
                .set("owner_user_id", conversation.ownerUserId())
                .set("device_id", conversation.deviceId())
                .set("agent_config_id", conversation.agentConfigId())
                .set("task_id", conversation.taskId())
                .set("status", ConversationStatus.dbOf(conversation.status()))
                .set("title", conversation.title())
                .set("brief_text", conversation.briefText())
                .set("brief_source", BriefSource.dbOf(conversation.briefSource()))
                .set("brief_updated_at", Times.ofMs(conversation.briefUpdatedAtMs()))
                .set("synced_sequence", conversation.syncedSequence())
                .set("native_session_id", conversation.nativeSessionId())
                .set("updated_at", Times.ofMs(conversation.updatedAtMs())));
        if (rows != 1) {
            throw new IllegalStateException("会话不存在");
        }
    }
}
