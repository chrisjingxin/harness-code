package workbench.collaboration.domain.conversation;

/**
 * 团队共享档位枚举：映射 {@code wb_conversation.share_mode} 列。
 *
 * <p>{@code full} 表示全文与简报同步，{@code summary_only} 表示仅公开状态、标题与简报而不上传消息正文。
 */
public enum ConversationShareMode {
    FULL(1, "full"),
    SUMMARY_ONLY(2, "summary_only");

    public final int dbCode;
    public final String code;

    ConversationShareMode(int dbCode, String code) {
        this.dbCode = dbCode;
        this.code = code;
    }

    /** 将协议字符串档位映射为数据库 TINYINT 编码。 */
    public static int dbOf(String code) {
        for (ConversationShareMode item : values()) {
            if (item.code.equals(code)) {
                return item.dbCode;
            }
        }
        throw new IllegalArgumentException("Unknown ConversationShareMode code: " + code);
    }

    /** 将数据库 TINYINT 编码还原为协议字符串档位。 */
    public static String codeOf(int dbCode) {
        for (ConversationShareMode item : values()) {
            if (item.dbCode == dbCode) {
                return item.code;
            }
        }
        throw new IllegalArgumentException("Unknown ConversationShareMode dbCode: " + dbCode);
    }
}
