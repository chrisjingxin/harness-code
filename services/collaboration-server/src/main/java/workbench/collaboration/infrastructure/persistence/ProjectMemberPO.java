package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：项目成员表持久化对象 (ProjectMemberPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_project_member 的持久化实体。
 * 移出成员只翻转 status 不删行（D9）：removed 记录保留审计事实，
 * updated_at_ms 供看板标注"已离开项目"。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectMemberMapper、ProjectConverter、ProjectRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_project_member")
public class ProjectMemberPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 所属项目标识 */
    @TableField("project_id")
    private String projectId;

    /** 成员用户标识 */
    @TableField("user_id")
    private String userId;

    /** 成员状态：active/removed */
    @TableField("status")
    private String status;

    /** 首次加入时间戳（毫秒，upsert 回 active 保留原值） */
    @TableField("created_at_ms")
    private Long createdAtMs;

    /** 状态最近变更时间戳（毫秒） */
    @TableField("updated_at_ms")
    private Long updatedAtMs;

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

    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Long getCreatedAtMs() {
        return createdAtMs;
    }

    public void setCreatedAtMs(Long createdAtMs) {
        this.createdAtMs = createdAtMs;
    }

    public Long getUpdatedAtMs() {
        return updatedAtMs;
    }

    public void setUpdatedAtMs(Long updatedAtMs) {
        this.updatedAtMs = updatedAtMs;
    }
}
