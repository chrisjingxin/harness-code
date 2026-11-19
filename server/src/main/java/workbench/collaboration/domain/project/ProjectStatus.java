package workbench.collaboration.domain.project;

/**
 * 模块：业务项目状态枚举 (ProjectStatus)
 *
 * <p>【功能定义】
 * 表达 wb_project.status 的合法取值。
 * active：正常协作；archived：归档只读——写操作一律拒绝（409 PROJECT_ARCHIVED），
 * 既有数据保留可读。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAccessPolicy、应用服务层。
 * - 下游依赖方：ProjectConverter 负责枚举与 TINYINT 列互转。
 */
public enum ProjectStatus {

    ACTIVE(1, "active"),
    ARCHIVED(2, "archived");

    private final int db;
    private final String code;

    ProjectStatus(int db, String code) {
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

    public static ProjectStatus fromDb(int db) {
        for (ProjectStatus status : values()) {
            if (status.db == db) {
                return status;
            }
        }
        throw new IllegalArgumentException("未知项目状态码: " + db);
    }
}
