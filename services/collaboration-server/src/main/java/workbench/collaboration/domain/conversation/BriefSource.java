package workbench.collaboration.domain.conversation;

/**
 * 模块：简报来源枚举 (BriefSource)
 *
 * <p>【功能定义】
 * 表达 wb_conversation.brief_source 的合法取值。
 * rule：规则化拼接（当前唯一实现）；agent：Agent 生成摘要（B1 预留，暂不接受写入）。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService。
 * - 下游依赖方：ConversationConverter 负责与 TINYINT 列互转。
 */
public enum BriefSource {

    RULE(1, "rule"),
    AGENT(2, "agent");

    private final int db;
    private final String code;

    BriefSource(int db, String code) {
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

    /** 契约字符串 → 数据库值 */
    public static int dbOf(String code) {
        return fromCode(code).db;
    }

    /** 数据库值 → 契约字符串 */
    public static String codeOf(int db) {
        for (BriefSource source : values()) {
            if (source.db == db) {
                return source.code;
            }
        }
        throw new IllegalArgumentException("未知简报来源码: " + db);
    }

    public static BriefSource fromCode(String code) {
        for (BriefSource source : values()) {
            if (source.code.equals(code)) {
                return source;
            }
        }
        throw new IllegalArgumentException("未知简报来源: " + code);
    }
}
