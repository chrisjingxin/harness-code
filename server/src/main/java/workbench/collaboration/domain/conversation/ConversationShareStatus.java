package workbench.collaboration.domain.conversation;

/**
 * 会话共享生命周期状态枚举：映射 {@code wb_conversation.share_status} 列。
 *
 * <p>{@code active} 表示允许持续增量同步；{@code stopped} 表示已停止共享，服务端保留冻结历史或简报快照并拒绝继续同步。
 */
public enum ConversationShareStatus {
    ACTIVE(1, "active"),
    STOPPED(2, "stopped");

    public final int dbCode;
    public final String code;

    ConversationShareStatus(int dbCode, String code) {
        this.dbCode = dbCode;
        this.code = code;
    }

    /** 将协议字符串共享状态映射为数据库 TINYINT 编码。 */
    public static int dbOf(String code) {
        for (ConversationShareStatus item : values()) {
            if (item.code.equals(code)) {
                return item.dbCode;
            }
        }
        throw new IllegalArgumentException("Unknown ConversationShareStatus code: " + code);
    }

    /** 将数据库 TINYINT 编码还原为协议字符串共享状态。 */
    public static String codeOf(int dbCode) {
        for (ConversationShareStatus item : values()) {
            if (item.dbCode == dbCode) {
                return item.code;
            }
        }
        throw new IllegalArgumentException("Unknown ConversationShareStatus dbCode: " + dbCode);
    }
}
