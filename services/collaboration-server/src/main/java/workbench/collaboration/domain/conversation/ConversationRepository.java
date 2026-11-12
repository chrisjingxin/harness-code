package workbench.collaboration.domain.conversation;

import java.util.List;
import java.util.Optional;

/**
 * 模块：会话头仓储端口接口 (ConversationRepository)
 *
 * <p>【功能定义】
 * 定义对 TDSQL 中会话头（wb_conversation）的持久化与并发访问契约。
 * 核心提供会话读取、插入、状态变更以及防并发序号错乱的悲观锁行锁查询。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、ExecutionAppService、DeviceAppService。
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
     * 当多个协作成员在极短时间内对同一会话发送指令或推进流时，必须避免两个请求并发分配出相同的递增序号 (sequence)。
     * 必须在外部短事务中调用本方法锁定该行记录，保证序号递增与状态变迁的原子性与串行性。
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
     * 全量更新会话头状态（如递增 nextSequence、切换 activeExecutionId 或更新当前用户）。
     *
     * @param conversation 待更新的会话聚合根实体
     */
    void update(Conversation conversation);

    /**
     * 按工作区游标分页列出会话列表（按创建时间倒序）。
     *
     * @param workspaceId 所属工作区标识
     * @param beforeCreatedAtMs 游标时间戳（毫秒），为 null 表示从最新记录开始查
     * @param beforeId 游标辅助标识，解决同一毫秒下的翻页确定性排序
     * @param limit 本次查询的最大条数
     * @return 会话头列表
     */
    List<Conversation> list(String workspaceId, Long beforeCreatedAtMs, String beforeId, int limit);
}
