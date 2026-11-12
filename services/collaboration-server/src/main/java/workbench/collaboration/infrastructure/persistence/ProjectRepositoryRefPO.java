package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：项目仓库引用表持久化对象 (ProjectRepositoryRefPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_project_repository 的持久化实体。
 * 记录"项目引用了团队目录中的哪个仓库"；取消引用即删行，
 * 不影响既有会话的历史仓库关联（wb_conversation_repository 独立保留）。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectRepositoryRefMapper、ProjectConverter、ProjectRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_project_repository")
public class ProjectRepositoryRefPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 引用方项目标识 */
    @TableField("project_id")
    private String projectId;

    /** 被引用的团队仓库标识 */
    @TableField("repository_id")
    private String repositoryId;

    /** 引用建立时间戳（毫秒） */
    @TableField("created_at_ms")
    private Long createdAtMs;

    public Long getPkId() {
        return pkId;
    }

    public void setPkId(Long pkId) {
        this.pkId = pkId;
    }

    public String getProjectId() {
        return projectId;
    }

    public void setProjectId(String projectId) {
        this.projectId = projectId;
    }

    public String getRepositoryId() {
        return repositoryId;
    }

    public void setRepositoryId(String repositoryId) {
        this.repositoryId = repositoryId;
    }

    public Long getCreatedAtMs() {
        return createdAtMs;
    }

    public void setCreatedAtMs(Long createdAtMs) {
        this.createdAtMs = createdAtMs;
    }
}
