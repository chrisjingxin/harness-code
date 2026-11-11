package workbench.collaboration.device;

import java.util.List;

/** 设备/项目 HTTP 与共享目标的线上形状；不包含本机路径或秘密。 */
public final class DeviceDtos {
  private DeviceDtos() {}

  public record AgentConfigSummary(String agentConfigId, String name, boolean available) {}
  public record DeviceSummary(String deviceId, String workspaceId, String ownerUserId, String name,
                              String createdAt, String revokedAt, String connectionState, String lastSeenAt) {}
  public record ProjectSummary(String projectId, String deviceId, String workspaceId, String name, boolean shareEnabled,
                               String shareVersion, String createdAt, String updatedAt, List<AgentConfigSummary> agentConfigs) {}
  public record DeviceRegistrationRequest(String registrationId, String deviceId, String installationId,
                                          String ledgerId, String name, String secret) {}
  public record DeviceRegistrationResponse(String registrationId, DeviceSummary device) {}
  public record DevicePageCursor(String beforeCreatedAt, String beforeDeviceId) {}
  public record DeviceListResponse(String workspaceId, List<DeviceSummary> devices, DevicePageCursor nextPage) {}
  public record DeviceRevokeRequest(String requestId) {}
  public record DeviceRevokedResponse(String deviceId, String revokedAt) {}
  public record ProjectPageCursor(String beforeCreatedAt, String beforeProjectId) {}
  public record ProjectListResponse(String workspaceId, String deviceId, List<ProjectSummary> projects, ProjectPageCursor nextPage) {}
  public record ProjectStopSharingRequest(String requestId, String expectedShareVersion) {}
  public record DeviceProjectPublishRequest(String requestId, String projectId, String name, boolean shareEnabled,
                                            String expectedShareVersion, List<AgentConfigSummary> agentConfigs) {}
  public record ProjectSavedResponse(String requestId, ProjectSummary project) {}

  public record DeviceWelcomePayload(String deviceId, String workspaceId, String ownerUserId, String ledgerId, String resumeId,
                                     int heartbeatIntervalMs, int heartbeatTimeoutMs) {}
  public record DeviceWelcomeMessage(int protocolVersion, String messageId, String type, String occurredAt, DeviceWelcomePayload payload) {}
  public record DeviceResumeInventoryPayload(String resumeId, String kind, String afterStartCommandId) {}
  public record DeviceResumeLookupPayload(String resumeId, String kind, String startCommandId) {}
  public record DeviceResumeRequestMessage(int protocolVersion, String messageId, String type, String occurredAt, Object payload) {}
  public record DeviceReadyPayload(String resumeId, String ledgerId) {}
  public record DeviceReadyMessage(int protocolVersion, String messageId, String type, String occurredAt, DeviceReadyPayload payload) {}
  public record DeviceProjectChangedPayload(String resumeId, String projectId, boolean shareEnabled, String shareVersion) {}
  public record DeviceProjectChangedMessage(int protocolVersion, String messageId, String type, String occurredAt, DeviceProjectChangedPayload payload) {}
  public record DeviceProblemPayload(String resumeId, String requestMessageId, String code, String message) {}
  public record DeviceProblemMessage(int protocolVersion, String messageId, String type, String occurredAt, DeviceProblemPayload payload) {}
  public record DeviceExecutionProblemMessage(int protocolVersion, String messageId, String type, String occurredAt, Object payload) {}
  public record DeviceResumePayload(String resumeId, String requestMessageId, String ledgerId, String afterStartCommandId,
                                    java.util.List<Object> records, String nextAfterStartCommandId) {}
  public record DeviceResumeMessage(int protocolVersion, String messageId, String type, String occurredAt, DeviceResumePayload payload) {}
  public record DeviceCommandStatusFoundPayload(String resumeId, String requestMessageId, String ledgerId, String startCommandId,
                                                String result, Object record) {}
  public record DeviceCommandStatusNotFoundPayload(String resumeId, String requestMessageId, String ledgerId, String startCommandId,
                                                   String result) {}
  public record DeviceCommandStatusMessage(int protocolVersion, String messageId, String type, String occurredAt, Object payload) {}

  /** 设备 Bearer 认证后的内部记录；秘密摘要不投影到任何线上 DTO。 */
  public record AuthenticatedDevice(String deviceId, String workspaceId, String ownerUserId, String ledgerId) {}
  /** 在调用方事务内读取的共享目标；shareVersion 固定为当前共享版本。 */
  public record SharedProject(String projectId, String deviceId, String workspaceId, String agentConfigId, long shareVersion) {}
  /** 文件读取只依赖已共享项目本身，不依赖 Agent 配置。 */
  public record ReadableProject(String projectId, String deviceId, String workspaceId, long shareVersion) {}
  /** 设备登记行，仅用于持久化与授权判断。 */
  public record DeviceRow(String id, String workspaceId, String ownerUserId, String ledgerId, String name, long createdAtMs, Long revokedAtMs) {}
  public record ProjectRow(String id, String deviceId, String workspaceId, String name, String rootRef, boolean shareEnabled,
                           long shareVersion, String agentConfigsJson, long createdAtMs, long updatedAtMs) {}
}
