package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.*;
import java.time.LocalDateTime;

/** 团队权限数据映射；由身份仓储读写，与唯一 schema.sql 一致。 */
@TableName("wb_workspace_member")
public class WorkspaceMemberPO {
  @TableId(value="id", type=IdType.AUTO)
  private Long id;
  public Long getId() { return id; }
  public void setId(Long value) { id=value; }
  @TableField("workspace_id")
  private String workspaceId;
  public String getWorkspaceId() { return workspaceId; }
  public void setWorkspaceId(String value) { workspaceId=value; }
  @TableField("user_id")
  private String userId;
  public String getUserId() { return userId; }
  public void setUserId(String value) { userId=value; }
  @TableField("role")
  private Integer role;
  public Integer getRole() { return role; }
  public void setRole(Integer value) { role=value; }
  @TableField("status")
  private Integer status;
  public Integer getStatus() { return status; }
  public void setStatus(Integer value) { status=value; }
  @TableField("version")
  private Long version;
  public Long getVersion() { return version; }
  public void setVersion(Long value) { version=value; }
  @TableField("created_at")
  private LocalDateTime createdAt;
  public LocalDateTime getCreatedAt() { return createdAt; }
  public void setCreatedAt(LocalDateTime value) { createdAt=value; }
  @TableField("updated_at")
  private LocalDateTime updatedAt;
  public LocalDateTime getUpdatedAt() { return updatedAt; }
  public void setUpdatedAt(LocalDateTime value) { updatedAt=value; }
  @TableField("left_at")
  private LocalDateTime leftAt;
  public LocalDateTime getLeftAt() { return leftAt; }
  public void setLeftAt(LocalDateTime value) { leftAt=value; }
}
