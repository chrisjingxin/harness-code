package workbench.collaboration.device;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.Contracts;
import workbench.collaboration.PlatformDtos;
import workbench.collaboration.device.DeviceDtos.*;
import workbench.collaboration.identity.WorkspaceAccess;
import workbench.collaboration.infrastructure.TimeCodec;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

/**
 * 设备与项目共享元数据：所有者明确登记/共享，秘密只存摘要；所有写操作加入调用方短事务。
 * 设备/项目表归本域，绝不写会话或执行表；SharedProjectAccess 只读共享版本。
 */
public final class DeviceService {
  public record RegistrationOutcome(boolean created, DeviceRegistrationResponse response) {}
  public record SavedOutcome(boolean created, ProjectSavedResponse response) {}

  private final JdbcTemplate jdbc;
  private final TransactionTemplate transaction;
  private final WorkspaceAccess access;
  private final Contracts contracts;
  private final DevicePresence presence;
  private final JsonMapper mapper = JsonMapper.builder().build();
  private final TypeReference<List<AgentConfigSummary>> agents = new TypeReference<>() {};

  public DeviceService(DataSource source, Contracts contracts, WorkspaceAccess access, DevicePresence presence) {
    jdbc = new JdbcTemplate(source); jdbc.setQueryTimeout(3);
    transaction = new TransactionTemplate(new JdbcTransactionManager(source));
    // 设备/项目写入有行锁；重试读当前已提交的首次回执，不能读事务开始时的旧快照。
    transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
    this.contracts = contracts; this.access = access; this.presence = presence;
  }

  public RegistrationOutcome register(String userId, String workspaceId, DeviceRegistrationRequest request) {
    String body = json(request);
    String scope = workspaceId + ":" + userId;
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      DeviceRegistrationResponse replay = receipt(scope, "device.register", request.registrationId(), body, DeviceRegistrationResponse.class);
      if (replay != null) return new RegistrationOutcome(false, replay);
      Integer installation = jdbc.queryForObject("SELECT COUNT(*) FROM wb_device WHERE installation_id = ?", Integer.class, request.installationId());
      if (!Integer.valueOf(0).equals(installation)) throw new ApiProblem(409, "REGISTRATION_CONFLICT");
      Integer ledger = jdbc.queryForObject("SELECT COUNT(*) FROM wb_device WHERE ledger_id = ?", Integer.class, request.ledgerId());
      if (!Integer.valueOf(0).equals(ledger)) throw new ApiProblem(409, "REGISTRATION_CONFLICT");
      long now = System.currentTimeMillis();
      try {
        jdbc.update("INSERT INTO wb_device (id,workspace_id,owner_user_id,installation_id,ledger_id,name,secret_hash,created_at_ms,revoked_at_ms) VALUES (?,?,?,?,?,?,?,?,NULL)",
          request.deviceId(), workspaceId, userId, request.installationId(), request.ledgerId(), request.name(), sha256(request.secret()), now);
      } catch (DuplicateKeyException duplicate) {
        replay = receipt(scope, "device.register", request.registrationId(), body, DeviceRegistrationResponse.class);
        if (replay != null) return new RegistrationOutcome(false, replay);
        throw new ApiProblem(409, "REGISTRATION_CONFLICT");
      }
      DeviceRegistrationResponse response = new DeviceRegistrationResponse(request.registrationId(), summary(new DeviceRow(request.deviceId(), workspaceId, userId, request.ledgerId(), request.name(), now, null)));
      saveReceipt(scope, "device.register", request.registrationId(), body, response);
      return new RegistrationOutcome(true, response);
    });
  }

  public DeviceListResponse listDevices(String userId, String workspaceId, String limit, String beforeCreatedAt, String beforeDeviceId) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      int size = pageSize(limit);
      long before = beforeCreatedAt == null ? Long.MAX_VALUE : TimeCodec.epoch(beforeCreatedAt);
      String cursor = beforeDeviceId == null ? "" : beforeDeviceId;
      List<DeviceRow> rows = jdbc.query("SELECT id,workspace_id,owner_user_id,ledger_id,name,created_at_ms,revoked_at_ms FROM wb_device WHERE workspace_id = ? AND owner_user_id = ? AND (created_at_ms < ? OR (created_at_ms = ? AND id > ?)) ORDER BY created_at_ms DESC, id ASC LIMIT ?",
        (row, n) -> new DeviceRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getLong(6), (Long) row.getObject(7)),
        workspaceId, userId, before, before, cursor, size + 1);
      List<DeviceSummary> devices = rows.stream().limit(size).map(this::summary).toList();
      DevicePageCursor next = rows.size() > size ? new DevicePageCursor(TimeCodec.utc(rows.get(size - 1).createdAtMs()), rows.get(size - 1).id()) : null;
      return new DeviceListResponse(workspaceId, devices, next);
    });
  }

  public ProjectListResponse listProjects(String userId, String workspaceId, String deviceId, String limit, String beforeCreatedAt, String beforeProjectId) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      requireOwner(deviceId, workspaceId, userId, false);
      int size = pageSize(limit);
      long before = beforeCreatedAt == null ? Long.MAX_VALUE : TimeCodec.epoch(beforeCreatedAt);
      String cursor = beforeProjectId == null ? "" : beforeProjectId;
      List<ProjectRow> rows = jdbc.query("SELECT id,device_id,workspace_id,name,root_ref,share_enabled,share_version,agent_configs_json,created_at_ms,updated_at_ms FROM wb_device_project WHERE device_id = ? AND (created_at_ms < ? OR (created_at_ms = ? AND id > ?)) ORDER BY created_at_ms DESC, id ASC LIMIT ?",
        (row, n) -> new ProjectRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getInt(6) == 1, row.getLong(7), row.getString(8), row.getLong(9), row.getLong(10)),
        deviceId, before, before, cursor, size + 1);
      List<ProjectSummary> projects = rows.stream().limit(size).map(this::summary).toList();
      ProjectPageCursor next = rows.size() > size ? new ProjectPageCursor(TimeCodec.utc(rows.get(size - 1).createdAtMs()), rows.get(size - 1).id()) : null;
      return new ProjectListResponse(workspaceId, deviceId, projects, next);
    });
  }

  public DeviceRevokedResponse revoke(String userId, String workspaceId, String deviceId, DeviceRevokeRequest request) {
    String body = deviceId + ":" + json(request);
    String scope = workspaceId + ":" + userId;
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      DeviceRow device = requireOwner(deviceId, workspaceId, userId, true);
      DeviceRevokedResponse replay = receipt(scope, "device.revoke", request.requestId(), body, DeviceRevokedResponse.class);
      if (replay != null) return replay;
      long revoked = device.revokedAtMs() == null ? System.currentTimeMillis() : device.revokedAtMs();
      if (device.revokedAtMs() == null) jdbc.update("UPDATE wb_device SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL", revoked, deviceId);
      DeviceRevokedResponse response = new DeviceRevokedResponse(deviceId, TimeCodec.utc(revoked));
      saveReceipt(scope, "device.revoke", request.requestId(), body, response);
      return response;
    });
  }

  /** 停止共享只递增版本、保留历史；已存在的执行仍可按原记录补传事实。 */
  public ProjectSavedResponse stopSharing(String userId, String workspaceId, String projectId, ProjectStopSharingRequest request) {
    String body = projectId + ":" + json(request);
    String scope = workspaceId + ":" + userId;
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      requireOwner(requireProject(projectId, false).deviceId(), workspaceId, userId, true);
      ProjectSavedResponse replay = receipt(scope, "project.stopSharing", request.requestId(), body, ProjectSavedResponse.class);
      if (replay != null) return replay;
      ProjectRow project = requireProject(projectId, true);
      long expected = parseVersion(request.expectedShareVersion());
      if (project.shareVersion() != expected) throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
      if (project.shareEnabled()) {
        jdbc.update("UPDATE wb_device_project SET share_enabled = 0, share_version = ?, updated_at_ms = ? WHERE id = ?",
          Math.incrementExact(expected), System.currentTimeMillis(), projectId);
        project = requireProject(projectId, true);
      }
      ProjectSavedResponse response = new ProjectSavedResponse(request.requestId(), summary(project));
      saveReceipt(scope, "project.stopSharing", request.requestId(), body, response);
      return response;
    });
  }

  /** 设备 Bearer 调用：设备所有者已在登记时固定，发布不能改写设备归属。 */
  public SavedOutcome publish(AuthenticatedDevice device, DeviceProjectPublishRequest request) {
    String body = json(request);
    String scope = device.deviceId();
    return transaction.execute(status -> {
      try { access.requireMember(device.workspaceId(), device.ownerUserId()); }
      catch (ApiProblem denied) { throw new ApiProblem(403, "DEVICE_ACTION_REJECTED"); }
      if (requireOwner(device.deviceId(), device.workspaceId(), device.ownerUserId(), true).revokedAtMs() != null)
        throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
      ProjectSavedResponse replay = receipt(scope, "device.project.save", request.requestId(), body, ProjectSavedResponse.class);
      if (replay != null) return new SavedOutcome(false, replay);
      ProjectRow existing = projectRows(request.projectId(), true).stream().findFirst().orElse(null);
      boolean created = existing == null;
      if (existing != null && !existing.deviceId().equals(device.deviceId())) throw new ApiProblem(403, "DEVICE_ACTION_REJECTED");
      long expected = parseVersion(request.expectedShareVersion());
      long now = System.currentTimeMillis();
      String configs = json(request.agentConfigs());
      if (existing == null) {
        if (expected != 0) throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
        try {
          jdbc.update("INSERT INTO wb_device_project (id,device_id,workspace_id,name,root_ref,share_enabled,share_version,agent_configs_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
            request.projectId(), device.deviceId(), device.workspaceId(), request.name(), "device-local:" + request.projectId(), request.shareEnabled() ? 1 : 0, 1, configs, now, now);
        } catch (DuplicateKeyException duplicate) { throw new ApiProblem(409, "SHARE_VERSION_CONFLICT"); }
      } else {
        if (existing.shareVersion() != expected) throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
        if (existing.shareEnabled() != request.shareEnabled() || !existing.name().equals(request.name())
          || !parseAgents(existing.agentConfigsJson()).equals(request.agentConfigs())) {
          jdbc.update("UPDATE wb_device_project SET name = ?, share_enabled = ?, share_version = ?, agent_configs_json = ?, updated_at_ms = ? WHERE id = ?",
            request.name(), request.shareEnabled() ? 1 : 0, Math.incrementExact(expected), configs, now, request.projectId());
        }
      }
      ProjectSavedResponse response = new ProjectSavedResponse(request.requestId(), summary(requireProject(request.projectId(), true)));
      saveReceipt(scope, "device.project.save", request.requestId(), body, response);
      return new SavedOutcome(created, response);
    });
  }

  /** 设备 ID 先定位登记，再以恒定时间核对摘要；撤销后不接受新连接。 */
  public AuthenticatedDevice authenticate(String authorization) {
    if (authorization == null || !authorization.matches("Bearer [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.[A-Za-z0-9_-]{43}"))
      throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
    String deviceId = authorization.substring(7, 43);
    byte[] hash = sha256(authorization.substring(44)).getBytes(StandardCharsets.US_ASCII);
    var rows = jdbc.query("SELECT id,workspace_id,owner_user_id,ledger_id,secret_hash FROM wb_device WHERE id = ? AND revoked_at_ms IS NULL",
      (row, n) -> MessageDigest.isEqual(hash, row.getString(5).getBytes(StandardCharsets.US_ASCII))
        ? new AuthenticatedDevice(row.getString(1), row.getString(2), row.getString(3), row.getString(4)) : null, deviceId);
    if (rows.isEmpty() || rows.getFirst() == null) throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
    return rows.getFirst();
  }

  /** 连接已建成后，撤销仍须阻止发送命令和写入回执。 */
  public boolean activeDevice(String deviceId) {
    return Integer.valueOf(1).equals(jdbc.queryForObject("SELECT COUNT(*) FROM wb_device WHERE id = ? AND revoked_at_ms IS NULL", Integer.class, deviceId));
  }

  /** 每次恢复都从此设备的真实项目读取共享版本。 */
  public List<DeviceProjectChangedPayload> projectVersions(String deviceId, String resumeId) {
    return jdbc.query("SELECT id,share_enabled,share_version FROM wb_device_project WHERE device_id = ? ORDER BY id",
      (row, n) -> new DeviceProjectChangedPayload(resumeId, row.getString(1), row.getInt(2) != 0, Long.toString(row.getLong(3))), deviceId);
  }

  /**
   * 共享目标校验：成员已由调用方确认；这里只判断设备未撤销、项目仍共享且 agent 配置存在。
   * 离线、未 ready 或端口暂不可用均可保存输入，派发可用性另行判断。
   */
  public SharedProject requireSharedProject(String workspaceId, String deviceId, String projectId, String agentConfigId) {
    var rows = jdbc.query("SELECT p.id,p.device_id,p.workspace_id,p.agent_configs_json,p.share_version FROM wb_device_project p JOIN wb_device d ON d.id = p.device_id WHERE p.id = ? AND p.device_id = ? AND p.workspace_id = ? AND p.share_enabled = 1 AND d.revoked_at_ms IS NULL",
      (row, n) -> new ProjectRow(row.getString(1), row.getString(2), row.getString(3), "", "", true, row.getLong(5), row.getString(4), 0, 0),
      projectId, deviceId, workspaceId);
    if (rows.isEmpty()) throw new ApiProblem(409, "PROJECT_NOT_SHARED");
    ProjectRow project = rows.getFirst();
    boolean registered = parseAgents(project.agentConfigsJson()).stream().anyMatch(agent -> agent.agentConfigId().equals(agentConfigId));
    if (!registered) throw new ApiProblem(409, "TARGET_UNAVAILABLE");
    return new SharedProject(project.id(), project.deviceId(), project.workspaceId(), agentConfigId, project.shareVersion());
  }

  /** 用于派发前的事实核对；不抛业务错误，返回空表示当前不可派发。 */
  public Optional<SharedProject> findSharedProject(String workspaceId, String deviceId, String projectId, String agentConfigId) {
    try { return Optional.of(requireSharedProject(workspaceId, deviceId, projectId, agentConfigId)); }
    catch (ApiProblem problem) { return Optional.empty(); }
  }

  private DeviceRow requireOwner(String deviceId, String workspaceId, String userId, boolean lock) {
    var rows = jdbc.query("SELECT id,workspace_id,owner_user_id,ledger_id,name,created_at_ms,revoked_at_ms FROM wb_device WHERE id = ? AND workspace_id = ?"
      + (lock ? " FOR UPDATE" : ""),
      (row, n) -> new DeviceRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getLong(6), (Long) row.getObject(7)), deviceId, workspaceId);
    if (rows.isEmpty() || !rows.getFirst().ownerUserId().equals(userId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
    return rows.getFirst();
  }

  private List<ProjectRow> projectRows(String projectId, boolean lock) {
    return jdbc.query("SELECT id,device_id,workspace_id,name,root_ref,share_enabled,share_version,agent_configs_json,created_at_ms,updated_at_ms FROM wb_device_project WHERE id = ?"
      + (lock ? " FOR UPDATE" : ""),
      (row, n) -> new ProjectRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getInt(6) == 1, row.getLong(7), row.getString(8), row.getLong(9), row.getLong(10)), projectId);
  }

  private ProjectRow requireProject(String projectId, boolean lock) {
    return projectRows(projectId, lock).stream().findFirst().orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
  }

  private DeviceSummary summary(DeviceRow row) {
    DevicePresence.Status status = presence.stateOf(row.id());
    return new DeviceSummary(row.id(), row.workspaceId(), row.ownerUserId(), row.name(), TimeCodec.utc(row.createdAtMs()),
      row.revokedAtMs() == null ? null : TimeCodec.utc(row.revokedAtMs()), status.state(), status.lastSeenAt() == null ? null : TimeCodec.utc(status.lastSeenAt()));
  }

  private ProjectSummary summary(ProjectRow row) {
    return new ProjectSummary(row.id(), row.deviceId(), row.workspaceId(), row.name(), row.shareEnabled(), Long.toString(row.shareVersion()),
      TimeCodec.utc(row.createdAtMs()), TimeCodec.utc(row.updatedAtMs()), parseAgents(row.agentConfigsJson()));
  }

  private List<AgentConfigSummary> parseAgents(String json) {
    try { return mapper.readValue(json, agents); }
    catch (RuntimeException e) { throw new IllegalStateException("项目 Agent 配置损坏", e); }
  }

  private int pageSize(String limit) {
    if (limit == null) return 50;
    int value = Integer.parseInt(limit);
    if (value < 1 || value > 100) throw new ApiProblem(400, "INVALID_REQUEST");
    return value;
  }

  private static long parseVersion(String value) {
    try { return Long.parseLong(value); }
    catch (NumberFormatException e) { throw new ApiProblem(400, "INVALID_REQUEST"); }
  }

  private String json(Object value) { return mapper.writeValueAsString(value); }

  private String bodyHash(String body) { return sha256(body); }

  /** 同一 requestId 同正文返回首次结果；不同正文 409，不覆盖原回执。 */
  private <T> T receipt(String scope, String operation, String requestId, String body, Class<T> type) {
    var rows = jdbc.query("SELECT body_sha256,response_json FROM wb_device_request WHERE operation = ? AND scope = ? AND request_id = ?",
      (row, n) -> Map.of("hash", row.getString(1), "body", row.getString(2)), operation, scope, requestId);
    if (rows.isEmpty()) return null;
    if (!rows.getFirst().get("hash").equals(bodyHash(body))) throw new ApiProblem(409, "REQUEST_ID_CONFLICT");
    return contracts.decode(type.getSimpleName(), rows.getFirst().get("body"), type);
  }

  private void saveReceipt(String scope, String operation, String requestId, String body, Object response) {
    try {
      jdbc.update("INSERT INTO wb_device_request (request_id,operation,scope,body_sha256,response_json,created_at_ms) VALUES (?,?,?,?,?,?)",
        requestId, operation, scope, bodyHash(body), contracts.encode(schemaOf(response), response), System.currentTimeMillis());
    } catch (DuplicateKeyException e) { throw new ApiProblem(409, "REQUEST_ID_CONFLICT"); }
  }

  private static String schemaOf(Object response) {
    return switch (response) {
      case DeviceRegistrationResponse ignored -> "DeviceRegistrationResponse";
      case DeviceRevokedResponse ignored -> "DeviceRevokedResponse";
      case ProjectSavedResponse ignored -> "ProjectSavedResponse";
      default -> throw new IllegalArgumentException("未登记的回执类型");
    };
  }

  private static String sha256(String value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch (NoSuchAlgorithmException e) { throw new IllegalStateException("SHA-256 不可用", e); }
  }
}
