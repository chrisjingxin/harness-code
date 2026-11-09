package workbench.collaboration.execution;

import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.conversation.ConversationDtos.ConversationRow;
import workbench.collaboration.conversation.ConversationDtos.ExecutionRow;

import javax.sql.DataSource;
import java.util.List;
import java.util.Map;

/** 派发、首次决定与原命令重送使用同一授权判断。读取已获准执行的历史不经过这个门槛。 */
final class ExecutionStartAuthorization {
  record Result(String denial, boolean available) {}

  private final JdbcTemplate jdbc;
  private final JsonMapper mapper = JsonMapper.builder().build();

  ExecutionStartAuthorization(DataSource source) {
    jdbc = new JdbcTemplate(source);
    jdbc.setQueryTimeout(3);
  }

  /** 按顺序锁发起人、成员和项目。调用方随后才能锁会话及执行。 */
  Result check(ConversationRow conversation, ExecutionRow execution) {
    var enabled = jdbc.queryForList("SELECT enabled FROM wb_user WHERE id = ? FOR UPDATE", Integer.class, execution.initiatedByUserId());
    var member = jdbc.queryForList("SELECT user_id FROM wb_workspace_member WHERE workspace_id = ? AND user_id = ? FOR UPDATE",
      String.class, conversation.workspaceId(), execution.initiatedByUserId());
    if (enabled.isEmpty() || enabled.getFirst() != 1 || member.isEmpty()) return new Result("AUTHOR_UNAVAILABLE", false);
    var rows = jdbc.query("SELECT d.revoked_at_ms,p.share_enabled,p.share_version,p.agent_configs_json FROM wb_device d "
      + "JOIN wb_device_project p ON p.device_id = d.id AND p.workspace_id = d.workspace_id WHERE d.id = ? AND d.workspace_id = ? AND p.id = ? FOR UPDATE",
      (row, n) -> new Object[]{row.getObject(1), row.getInt(2), row.getLong(3), row.getString(4)},
      conversation.deviceId(), conversation.workspaceId(), conversation.projectId());
    if (rows.isEmpty()) return new Result("TARGET_INVALID", false);
    Object[] row = rows.getFirst();
    if (((Number) row[1]).intValue() != 1) return new Result("PROJECT_NOT_SHARED", false);
    if (((Number) row[2]).longValue() != execution.shareVersion()) return new Result("SHARE_VERSION_CHANGED", false);
    if (row[0] != null) return new Result("DEVICE_REVOKED", false);
    return agent((String) row[3], execution.agentConfigId());
  }

  /** 已登记但端口不可用仍有授权，派发时应等待端口恢复。 */
  private Result agent(String json, String agentConfigId) {
    try {
      var list = mapper.readValue(json, List.class);
      for (Object item : list) {
        if (item instanceof Map<?, ?> map && agentConfigId.equals(map.get("agentConfigId")))
          return new Result(null, Boolean.TRUE.equals(map.get("available")));
      }
    } catch (RuntimeException e) {
      return new Result("TARGET_INVALID", false);
    }
    return new Result("TARGET_INVALID", false);
  }

}
