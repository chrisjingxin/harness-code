package workbench.collaboration.identity;

import workbench.collaboration.PlatformDtos.*;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.security.authentication.BadCredentialsException;
import javax.sql.DataSource;
import java.util.List;

/**
 * 普通身份与成员读取：会话内部 ID → 启用状态 → 成员关系 → 限定范围 DTO。
 * 每个受保护读取使用一笔短只读事务，不将登录时的成员列表当成永久授权。
 */
public final class IdentityService {
  private final JdbcTemplate jdbc;
  private final TransactionTemplate read;
  private final WorkspaceAccess access;
  public IdentityService(DataSource source) {
    jdbc = new JdbcTemplate(source); jdbc.setQueryTimeout(2);
    read = new TransactionTemplate(new JdbcTransactionManager(source)); read.setReadOnly(true);
    access = new WorkspaceAccess(source);
  }
  /** 演示认证只检查预置用户名和启用状态；不存在/停用均不建立会话。 */
  public String authenticate(String username) {
    var ids = jdbc.queryForList("SELECT id FROM wb_user WHERE username = ? AND enabled = 1", String.class, username);
    if (ids.isEmpty()) throw new BadCredentialsException("预置账号不可用");
    return ids.getFirst();
  }
  public DemoUsersResponse demoUsers() {
    return new DemoUsersResponse(jdbc.query("SELECT id,username,display_name FROM wb_user WHERE enabled = 1 AND username IN ('user01','user02','user03') ORDER BY username", (row, n) -> new UserSummary(row.getString(1), row.getString(2), row.getString(3))));
  }
  public CurrentUserResponse current(String userId) {
    return read.execute(s -> new CurrentUserResponse(access.requireEnabledUser(userId), access.workspaces(userId)));
  }
  public WorkspaceListResponse listWorkspaces(String userId) {
    return read.execute(s -> { access.requireEnabledUser(userId); return new WorkspaceListResponse(access.workspaces(userId)); });
  }
  /** 不存在和非成员均返回404；绝不通过请求正文替换当前操作人。 */
  public MembersResponse members(String userId, String workspaceId) {
    return read.execute(s -> {
      access.requireMember(workspaceId, userId);
      var members = jdbc.query("SELECT u.id,u.username,u.display_name FROM wb_workspace_member m JOIN wb_user u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.enabled = 1 ORDER BY u.username", (row, n) -> new MemberSummary(new UserSummary(row.getString(1), row.getString(2), row.getString(3))), workspaceId);
      return new MembersResponse(workspaceId, members);
    });
  }
  public WorkspaceAccess access() { return access; }
}
