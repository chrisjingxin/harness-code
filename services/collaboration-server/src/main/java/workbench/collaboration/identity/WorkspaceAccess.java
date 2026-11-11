package workbench.collaboration.identity;

import workbench.collaboration.PlatformDtos.*;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.jdbc.core.JdbcTemplate;
import javax.sql.DataSource;
import java.util.List;

/**
 * 同一库内的唯一授权入口：启用用户 → 工作区成员 → 限定 DTO。
 * 身份读取与会话/设备写事务都复用它，不各写一套成员判断。
 */
public final class WorkspaceAccess {
  private final JdbcTemplate jdbc;
  public WorkspaceAccess(DataSource source) { jdbc = new JdbcTemplate(source); jdbc.setQueryTimeout(2); }

  /** 不存在/停用均不建立会话，也不允许继续业务读取。 */
  public UserSummary requireEnabledUser(String userId) {
    var users = jdbc.query("SELECT id,username,display_name FROM wb_user WHERE id = ? AND enabled = 1",
      (row, n) -> new UserSummary(row.getString(1), row.getString(2), row.getString(3)), userId);
    if (users.isEmpty()) throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
    return users.getFirst();
  }

  public boolean isMember(String workspaceId, String userId) {
    Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM wb_workspace_member WHERE workspace_id = ? AND user_id = ?", Integer.class, workspaceId, userId);
    return Integer.valueOf(1).equals(count);
  }

  /** 不存在和非成员均返回 404，不向非成员泄露工作区是否存在。 */
  public UserSummary requireMember(String workspaceId, String userId) {
    UserSummary user = requireEnabledUser(userId);
    if (!isMember(workspaceId, userId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
    return user;
  }

  /** 不检查成员关系，仅用于当前用户自己的列表；调用方仍须先确认启用状态。 */
  public List<WorkspaceSummary> workspaces(String userId) {
    return jdbc.query("SELECT w.id,w.slug,w.name FROM wb_workspace w JOIN wb_workspace_member m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.slug",
      (row, n) -> new WorkspaceSummary(row.getString(1), row.getString(2), row.getString(3)), userId);
  }
}
