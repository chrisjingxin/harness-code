package workbench.collaboration.interfaces.dto;

import java.util.List;

/**
 * 模块：设备与项目数据传输对象集 (DeviceDtos)
 *
 * <p>【功能定义】
 * 定义 Electron Daemon 设备注册、共享代码项目维护以及 WebSocket 长连接交互信令的传输形态。
 * 敏感凭据脱敏：响应中只公开设备状态与哈希，绝不泄露机器私密路径与原始密钥。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceController、DaemonWebSocketHandler、DeviceAppService。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class DeviceDtos {

    private DeviceDtos() {}

    /** Agent 运行配置摘要 */
    public record AgentConfigSummary(
            String agentConfigId,
            String name,
            boolean available
    ) {}

    /** 设备概要视图 */
    public record DeviceSummary(
            String deviceId,
            String workspaceId,
            String ownerUserId,
            String name,
            String createdAt,
            String revokedAt,
            String connectionState,
            String lastSeenAt
    ) {}

    /** 共享项目概要视图 */
    public record ProjectSummary(
            String projectId,
            String deviceId,
            String workspaceId,
            String name,
            boolean shareEnabled,
            String shareVersion,
            String createdAt,
            String updatedAt,
            List<AgentConfigSummary> agentConfigs
    ) {}

    /** 设备入网注册请求 */
    public record DeviceRegistrationRequest(
            String registrationId,
            String deviceId,
            String installationId,
            String ledgerId,
            String name,
            String secret
    ) {}

    /** 设备注册确认响应 */
    public record DeviceRegistrationResponse(
            String registrationId,
            DeviceSummary device
    ) {}

    /** 设备分页游标 */
    public record DevicePageCursor(
            String beforeCreatedAt,
            String beforeDeviceId
    ) {}

    /** 设备列表分页响应 */
    public record DeviceListResponse(
            String workspaceId,
            List<DeviceSummary> devices,
            DevicePageCursor nextPage
    ) {}

    /** 吊销设备请求 */
    public record DeviceRevokeRequest(
            String requestId
    ) {}

    /** 吊销设备确认响应 */
    public record DeviceRevokedResponse(
            String deviceId,
            String revokedAt
    ) {}

    /** 项目分页游标 */
    public record ProjectPageCursor(
            String beforeCreatedAt,
            String beforeProjectId
    ) {}

    /** 项目列表分页响应 */
    public record ProjectListResponse(
            String workspaceId,
            String deviceId,
            List<ProjectSummary> projects,
            ProjectPageCursor nextPage
    ) {}

    /** 停止项目共享请求 */
    public record ProjectStopSharingRequest(
            String requestId,
            String expectedShareVersion
    ) {}

    /** 发布/更新项目共享配置请求 */
    public record DeviceProjectPublishRequest(
            String requestId,
            String projectId,
            String name,
            boolean shareEnabled,
            String expectedShareVersion,
            List<AgentConfigSummary> agentConfigs
    ) {}

    /** 项目保存确认响应 */
    public record ProjectSavedResponse(
            String requestId,
            ProjectSummary project
    ) {}

    // ─── WebSocket 长连接通道双向封包定义 ───

    public record DeviceWelcomePayload(
            String deviceId,
            String workspaceId,
            String ownerUserId,
            String ledgerId,
            String resumeId,
            int heartbeatIntervalMs,
            int heartbeatTimeoutMs
    ) {}

    public record DeviceWelcomeMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            DeviceWelcomePayload payload
    ) {}

    public record DeviceResumeInventoryPayload(
            String resumeId,
            String kind,
            String afterStartCommandId
    ) {}

    public record DeviceResumeLookupPayload(
            String resumeId,
            String kind,
            String startCommandId
    ) {}

    public record DeviceResumeRequestMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            Object payload
    ) {}

    public record DeviceReadyPayload(
            String resumeId,
            String ledgerId
    ) {}

    public record DeviceReadyMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            DeviceReadyPayload payload
    ) {}

    public record DeviceProjectChangedPayload(
            String resumeId,
            String projectId,
            boolean shareEnabled,
            String shareVersion
    ) {}

    public record DeviceProjectChangedMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            DeviceProjectChangedPayload payload
    ) {}

    public record DeviceProblemPayload(
            String resumeId,
            String requestMessageId,
            String code,
            String message
    ) {}

    public record DeviceProblemMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            DeviceProblemPayload payload
    ) {}

    public record DeviceExecutionProblemMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            Object payload
    ) {}

    public record DeviceResumePayload(
            String resumeId,
            String requestMessageId,
            String ledgerId,
            String afterStartCommandId,
            java.util.List<Object> records,
            String nextAfterStartCommandId
    ) {}

    public record DeviceResumeMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            DeviceResumePayload payload
    ) {}

    public record DeviceCommandStatusFoundPayload(
            String resumeId,
            String requestMessageId,
            String ledgerId,
            String startCommandId,
            String result,
            Object record
    ) {}

    public record DeviceCommandStatusNotFoundPayload(
            String resumeId,
            String requestMessageId,
            String ledgerId,
            String startCommandId,
            String result
    ) {}

    public record DeviceCommandStatusMessage(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            Object payload
    ) {}
}
