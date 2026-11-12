package workbench.collaboration.domain.repository;

/**
 * 模块：团队仓库状态枚举 (RepositoryStatus)
 *
 * <p>【功能定义】
 * 表达 wb_repository.status 的合法取值。
 * active：可被项目引用；archived：归档——不可被新引用（409 REPOSITORY_ARCHIVED），
 * 既有项目引用与会话关联保留只读。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAccessPolicy、RepositoryAppService。
 * - 下游依赖方：RepositoryConverter 负责枚举与 VARCHAR 列互转。
 */
public enum RepositoryStatus {

    ACTIVE("active"),
    ARCHIVED("archived");

    private final String code;

    RepositoryStatus(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }

    public static RepositoryStatus fromCode(String code) {
        for (RepositoryStatus status : values()) {
            if (status.code.equals(code)) {
                return status;
            }
        }
        throw new IllegalArgumentException("未知仓库状态: " + code);
    }
}
