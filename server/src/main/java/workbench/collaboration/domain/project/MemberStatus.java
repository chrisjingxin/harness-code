package workbench.collaboration.domain.project;

/**
 * 模块：项目成员状态枚举 (MemberStatus)
 *
 * <p>【功能定义】
 * 表达 wb_project_member.status 的合法取值。
 * active：在册成员；removed：已移出——行保留不删（D9），
 * removed 成员立即失去读权且其设备对本项目的同步被拒。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAccessPolicy、应用服务层。
 * - 下游依赖方：ProjectConverter 负责枚举与 TINYINT 列互转。
 */
public enum MemberStatus {

    ACTIVE(1, "active"),
    REMOVED(2, "removed");

    private final int db;
    private final String code;

    MemberStatus(int db, String code) {
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

    public static MemberStatus fromDb(int db) {
        for (MemberStatus status : values()) {
            if (status.db == db) {
                return status;
            }
        }
        throw new IllegalArgumentException("未知成员状态码: " + db);
    }
}
