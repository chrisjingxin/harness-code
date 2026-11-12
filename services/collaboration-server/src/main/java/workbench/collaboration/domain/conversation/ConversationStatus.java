package workbench.collaboration.domain.conversation;

/**
 * 模块：会话运行状态枚举 (ConversationStatus)
 *
 * <p>【功能定义】
 * 表达 wb_conversation.status 的合法取值。
 * idle：空闲；running：执行中；waiting_approval：等待本机审批；error：异常。
 * 状态机由 owner Runner 侧驱动，Java 侧只作校验与持久化，不做流转裁决。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService（写）、ConversationAppService（过滤读）。
 * - 下游依赖方：ConversationConverter 负责与 TINYINT 列互转。
 */
public enum ConversationStatus {

    IDLE(1, "idle"),
    RUNNING(2, "running"),
    WAITING_APPROVAL(3, "waiting_approval"),
    ERROR(4, "error");

    private final int db;
    private final String code;

    ConversationStatus(int db, String code) {
        this.db = db;
        this.code = code;
    }

    /** 数据库 TINYINT 存储值 */
    public int db() {
        return db;
    }

    /** 对外契约字符串值 */
    public String code() {
        return code;
    }

    /** 契约字符串 → 数据库值（查询过滤用） */
    public static int dbOf(String code) {
        return fromCode(code).db;
    }

    /** 数据库值 → 契约字符串 */
    public static String codeOf(int db) {
        for (ConversationStatus status : values()) {
            if (status.db == db) {
                return status.code;
            }
        }
        throw new IllegalArgumentException("未知会话状态码: " + db);
    }

    public static ConversationStatus fromCode(String code) {
        for (ConversationStatus status : values()) {
            if (status.code.equals(code)) {
                return status;
            }
        }
        throw new IllegalArgumentException("未知会话状态: " + code);
    }
}
