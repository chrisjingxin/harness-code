package workbench.collaboration.application.service;

import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.infrastructure.contract.ExecutionCodec;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.Optional;
import java.util.function.Supplier;

/**
 * 模块：请求幂等执行编排器 (IdempotentCalls)
 *
 * <p>【功能定义】
 * 统一封装所有外部高频写操作的防重重放流水线。
 * 实现“首次执行记录、并发冲突拦截、错误自动放行、重复重放缓存”的高可靠执行闭环。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、DeviceAppService。
 * - 下游依赖方：IdempotencyPort、ExecutionCodec、ApiProblem。
 *
 * <p>【幂等调用流水线时序】
 * <pre>
 * 客户端请求 ──> 计算载荷指纹 fingerprint
 *                      │
 *                      ▼
 *          [IdempotencyPort.begin]
 *          ├── 检测到冲突/指纹不匹配 ──> 抛出 ApiProblem(409, "REQUEST_ID_CONFLICT")
 *          ├── 已有历史定稿响应     ──> 直接返回缓存响应（无需重复走数据库）
 *          └── 首次到达，完成占位
 *                      │
 *                      ▼
 *               执行业务逻辑 Supplier.get()
 *                      │
 *              ┌───────┴───────┐
 *              ▼               ▼
 *            [成功]          [异常]
 *       保存响应定稿       释放占位 (abort)
 *      (port.remember)   向上抛出原始异常
 * </pre>
 */
public final class IdempotentCalls {

    private IdempotentCalls() {}

    /**
     * 计算组合入参的内容哈希指纹（SHA-256）。
     *
     * @param parts 需参与指纹比对的关键字符串片段
     * @return 64 位十六进制 SHA-256 字符串
     */
    public static String fingerprint(String... parts) {
        return ExecutionCodec.hex(String.join("\n", parts));
    }

    /**
     * 在幂等守卫保护下安全执行业务写入操作。
     *
     * <p>【并发与异常防护动机 (Why)】
     * 1. 相同正文的并发或重试请求复用第一次计算出的定稿响应，消除重复写入；
     * 2. 相同 requestId 但正文不同的伪造请求立即被 409 阻断；
     * 3. 业务抛出运行时异常时，必须捕获并在 abort 释放占位后重新向上抛出，避免死锁占位。
     *
     * @param port 幂等存储端口
     * @param workspaceId 所属工作区标识
     * @param actorId 操作主体标识
     * @param operation 业务操作标识
     * @param requestId 客户端请求标识
     * @param fingerprint 请求体指纹
     * @param write 业务具体写入逻辑闭包
     * @return 业务响应 JSON 字符串
     */
    public static String run(
            IdempotencyPort port,
            String workspaceId,
            String actorId,
            String operation,
            String requestId,
            String fingerprint,
            Supplier<String> write
    ) {
        Optional<String> existing;
        try {
            existing = port.begin(workspaceId, actorId, operation, requestId, fingerprint);
        } catch (IllegalStateException conflict) {
            // 捕获指纹不匹配或并发冲突异常，转化为标准 HTTP 409 业务错误
            throw new ApiProblem(409, "REQUEST_ID_CONFLICT");
        }

        // 命中了已完成的幂等缓存，直接原样重放
        if (existing.isPresent()) {
            return existing.get();
        }

        try {
            // 执行真实业务写入
            String response = write.get();
            // 业务成功：持久化最终定稿响应，供后续网络超时重放
            port.remember(workspaceId, actorId, operation, requestId, fingerprint, response);
            return response;
        } catch (RuntimeException failure) {
            // 业务异常：必须放开在途占位，否则后续该请求发起重试会被永久卡死在冲突状态
            port.abort(workspaceId, actorId, operation, requestId);
            throw failure;
        }
    }
}
