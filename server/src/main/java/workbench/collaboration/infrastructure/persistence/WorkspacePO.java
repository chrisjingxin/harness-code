package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.*;
import java.time.LocalDateTime;

/** 团队权限数据映射；由身份仓储读写，与唯一 schema.sql 一致。 */
@TableName("wb_workspace")
public class WorkspacePO {
  @TableId(value="id", type=IdType.AUTO)
  private Long id;
  public Long getId() { return id; }
  public void setId(Long value) { id=value; }
  @TableField("workspace_id")
  private String workspaceId;
  public String getWorkspaceId() { return workspaceId; }
  public void setWorkspaceId(String value) { workspaceId=value; }
  @TableField("slug")
  private String slug;
  public String getSlug() { return slug; }
  public void setSlug(String value) { slug=value; }
  @TableField("name")
  private String name;
  public String getName() { return name; }
  public void setName(String value) { name=value; }
  @TableField("creator_user_id")
  private String creatorUserId;
  public String getCreatorUserId() { return creatorUserId; }
  public void setCreatorUserId(String value) { creatorUserId=value; }
  @TableField("access_version")
  private Long accessVersion;
  public Long getAccessVersion() { return accessVersion; }
  public void setAccessVersion(Long value) { accessVersion=value; }
  @TableField("created_at")
  private LocalDateTime createdAt;
  public LocalDateTime getCreatedAt() { return createdAt; }
  public void setCreatedAt(LocalDateTime value) { createdAt=value; }
}
