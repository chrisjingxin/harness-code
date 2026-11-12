package workbench.collaboration.domain.conversation;

import workbench.collaboration.interfaces.ApiProblem;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

/**
 * 模块：会话同步批次校验器 (SyncBatch)
 *
 * <p>【功能定义】
 * 校验主人 Runner 上送的一批定稿消息是否可写：
 * 序号连续性（批首 == 服务端水位+1、批内逐个 +1）、消息类型枚举合法、
 * 单条载荷与整批字节上限。只校验，不代分配序号——序号永远由主人 Runner 给定（D 单写者）。
 *
 * <p>【判定结果】
 * - {@link Verdict#REPLAY}：批首序号 ≤ 服务端水位 → 整批是历史重放，幂等返回当前水位；
 * - {@link Verdict#APPLY}：校验通过，可写入；
 * - 其余一律抛 ApiProblem：跳号 → 409 SEQUENCE_CONFLICT（带 expectedSequence），
 *   类型非法/尺寸超限 → 400 INVALID_REQUEST。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService。
 * - 下游依赖方：ApiProblem（受控错误词汇）。
 */
public final class SyncBatch {

    /** 单条消息载荷上限：32KB（UTF-8 字节） */
    public static final int MESSAGE_PAYLOAD_LIMIT = 32 * 1024;
    /** 整批消息载荷合计上限：1MB（UTF-8 字节） */
    public static final int BATCH_PAYLOAD_LIMIT = 1024 * 1024;

    private static final Set<String> MESSAGE_TYPES = Set.of("user", "assistant", "tool_summary", "status");

    private SyncBatch() {}

    /** 校验结论 */
    public enum Verdict { REPLAY, APPLY }

    /** 上送批次中的单条消息（已由契约解码，业务字段齐备） */
    public record Item(long sequence, String type, long occurredAtMs, String payload) {}

    /**
     * 校验批次并给出处置结论。
     *
     * @param syncedSequence 服务端已确认的最大消息序号（水位）
     * @param items 本批上送消息（允许为空：空批仅携带简报更新）
     * @return REPLAY 或 APPLY
     */
    public static Verdict validate(long syncedSequence, List<Item> items) {
        if (items.isEmpty()) {
            return Verdict.APPLY;
        }
        long first = items.getFirst().sequence();
        if (first <= syncedSequence) {
            return Verdict.REPLAY;
        }
        long expected = syncedSequence + 1;
        if (first != expected) {
            throw new ApiProblem(409, "SEQUENCE_CONFLICT", expected);
        }
        long batchBytes = 0;
        long sequence = expected;
        for (Item item : items) {
            if (item.sequence() != sequence) {
                throw new ApiProblem(409, "SEQUENCE_CONFLICT", sequence);
            }
            if (!MESSAGE_TYPES.contains(item.type())) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            int bytes = item.payload() == null ? 0 : item.payload().getBytes(StandardCharsets.UTF_8).length;
            if (bytes > MESSAGE_PAYLOAD_LIMIT) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            batchBytes += bytes;
            if (batchBytes > BATCH_PAYLOAD_LIMIT) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            sequence++;
        }
        return Verdict.APPLY;
    }
}
