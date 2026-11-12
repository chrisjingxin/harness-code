package workbench.collaboration.application.port;

import java.util.Optional;

/**
 * 模块：请求幂等防重端口接口 (IdempotencyPort)
 *
 * <p>【功能定义】
 * 提供对客户端发起的写操作请求（如发送输入、创建会话、发布项目）在 1 小时窗口内的幂等防重保障。
 * 遵循“两阶段预占与提交”机制：
 * 1. 初次请求：通过 requestId 占位，执行业务逻辑，成功后将序列化结果缓存；
 * 2. 重放请求：若检测到相同 requestId 且请求体指纹一致，直接返回已缓存的响应结果（HTTP 200/原样返回）；
 * 3. 冲突请求：若相同 requestId 但请求内容指纹不一致，抛出异常阻断请求（HTTP 409）。
 *
 * <p>【协作边界】
 * - 上游调用方：IdempotentCalls、ConversationAppService、DeviceAppService。
 * - 下游实现方：infrastructure/cache/JedisCollaborationState、infrastructure/cache/MemoryIdempotency。
 */
public interface IdempotencyPort {

    /**
     * 尝试开始一个幂等调用流程。
     *
     * <p>【并发控制动机 (Why)】
     * - 若该 requestId 为首次出现，在缓存中写入占位符（In-Progress），返回 Optional.empty()；
     * - 若该 requestId 已有定稿结果且指纹一致，直接返回已保存的响应 JSON 供重放；
     * - 若该 requestId 正在被其他并发请求处理，或者指纹不匹配，抛出 IllegalStateException 阻止脏写。
     *
     * @param workspaceId 所属工作区标识
     * @param actorId 操作主体标识（用户ID或设备ID）
     * @param operation 业务操作标识（如 "input.send"、"conversation.create"）
     * @param requestId 客户端生成的请求全局唯一标识 (UUID)
     * @param bodySha256 请求原始报文的 SHA-256 哈希指纹
     * @return 存在已完成的幂等响应时返回 Optional 包含该响应，首次请求返回 Optional.empty()
     * @throws IllegalStateException 当检测到指纹冲突或并发重复占用时抛出
     */
    Optional<String> begin(String workspaceId, String actorId, String operation, String requestId, String bodySha256);

    /**
     * 业务操作执行成功后，将定稿响应 JSON 记录并绑定到该幂等键，设置 1 小时 TTL。
     *
     * @param workspaceId 所属工作区标识
     * @param actorId 操作主体标识
     * @param operation 业务操作标识
     * @param requestId 请求唯一标识
     * @param bodySha256 请求体指纹
     * @param responseJson 业务返回的定稿 JSON 响应
     */
    void remember(String workspaceId, String actorId, String operation, String requestId, String bodySha256, String responseJson);

    /**
     * 当业务处理异常抛出时，必须主动释放该 requestId 的在途占位。
     *
     * <p>【防护动机 (Why)】
     * 避免因单次网络/数据库偶发异常导致占位符长期锁死，确保客户端发起重试时能够重新进入执行逻辑。
     *
     * @param workspaceId 所属工作区标识
     * @param actorId 操作主体标识
     * @param operation 业务操作标识
     * @param requestId 请求唯一标识
     */
    void abort(String workspaceId, String actorId, String operation, String requestId);

    /**
     * 仅只读查询已完成的幂等回执。
     *
     * @param workspaceId 所属工作区标识
     * @param actorId 操作主体标识
     * @param operation 业务操作标识
     * @param requestId 请求唯一标识
     * @return 存在时返回响应 JSON，不存在或仍在执行中返回 Optional.empty()
     */
    Optional<String> find(String workspaceId, String actorId, String operation, String requestId);
}
