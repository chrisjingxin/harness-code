package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

/**
 * 模块：工作区成员关联表持久化对象 (WorkspaceMemberPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_workspace_member 的持久化实体。
 * 记录工作区与用户的归属绑定。通过 (workspace_id, user_id) 建立联合唯一约束。
 *
 * <p>【协作边界】
 * - 上游调用方：WorkspaceMemberMapper、IdentityConverter、IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_workspace_member")
public class WorkspaceMemberPO {

    /** 物理主键（BIGINT UNSIGNED AUTO_INCREMENT） */
    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    /** 所属工作区业务标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 成员用户业务标识 */
    @TableField("user_id")
    private String userId;

    /** 加入时间戳（毫秒） */
    @TableField("created_at")
    private LocalDateTime createdAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public void setWorkspaceId(String workspaceId) {
        this.workspaceId = workspaceId;
    }

    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
