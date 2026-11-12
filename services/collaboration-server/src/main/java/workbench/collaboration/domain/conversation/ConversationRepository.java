package workbench.collaboration.domain.conversation;

import java.util.List;
import java.util.Optional;

/**
 * 模块：会话头仓储端口接口 (ConversationRepository)
 *
 * <p>【功能定义】
 * 定义对 TDSQL 中会话头（wb_conversation）的持久化与并发访问契约。
 * 提供会话读取、插入、简报与水位更新，以及防并发推进的悲观行锁查询。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService。
 * - 下游实现方：infrastructure/persistence/ConversationRepositoryImpl（基于 MyBatis-Plus）。
 */
public interface ConversationRepository {

    /**
     * 根据会话标识查询会话头（无锁读）。
     *
     * @param id 会话全局唯一标识
     * @return 存在时返回包含 Conversation 的 Optional，否则返回 Optional.empty()
     */
    Optional<Conversation> findById(String id);

    /**
     * 根据会话标识加悲观行锁查询（SELECT ... FOR UPDATE）。
     *
     * <p>【并发控制动机 (Why)】
     * 同步上传推进 synced_sequence 水位时必须在外部短事务中锁定该行，
     * 保证水位校验与推进的原子性，杜绝并发批次互相覆盖水位。
     *
     * @param id 会话全局唯一标识
     * @return 锁定后的 Conversation 实例
     */
    Optional<Conversation> lockById(String id);

    /**
     * 新建并插入一条会话头记录。
     *
     * @param conversation 会话聚合根实体
     */
    void insert(Conversation conversation);

    /**
     * 全量更新会话头状态（状态、简报、水位与时间戳）。
     *
     * @param conversation 待更新的会话聚合根实体
     */
    void update(Conversation conversation);

    /**
     * 按项目游标分页列出会话列表（按最近更新时间倒序，供简报看板）。
     *
     * @param projectId 所属业务项目标识
     * @param beforeUpdatedAtMs 游标时间戳（毫秒），为 null 表示从最新记录开始查
     * @param beforeId 游标辅助标识，解决同一毫秒下的翻页确定性排序
     * @param limit 本次查询的最大条数
     * @return 会话头列表
     */
    List<Conversation> listByProject(String projectId, Long beforeUpdatedAtMs, String beforeId, int limit);
}
