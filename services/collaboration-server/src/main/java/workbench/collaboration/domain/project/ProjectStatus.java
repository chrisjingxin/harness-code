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
 * - 下游依赖方：ProjectConverter 负责枚举与 VARCHAR 列互转。
 */
public enum ProjectStatus {

    ACTIVE("active"),
    ARCHIVED("archived");

    private final String code;

    ProjectStatus(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }

    public static ProjectStatus fromCode(String code) {
        for (ProjectStatus status : values()) {
            if (status.code.equals(code)) {
                return status;
            }
        }
        throw new IllegalArgumentException("未知项目状态: " + code);
    }
}
