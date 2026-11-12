package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

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

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 所属工作区业务标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 成员用户业务标识 */
    @TableField("user_id")
    private String userId;

    /** 加入时间戳（毫秒） */
    @TableField("created_at_ms")
    private Long createdAtMs;

    public Long getPkId() {
        return pkId;
    }

    public void setPkId(Long pkId) {
        this.pkId = pkId;
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

    public Long getCreatedAtMs() {
        return createdAtMs;
    }

    public void setCreatedAtMs(Long createdAtMs) {
        this.createdAtMs = createdAtMs;
    }
}
