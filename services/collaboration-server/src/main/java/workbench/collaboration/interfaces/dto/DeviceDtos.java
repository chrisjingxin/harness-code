package workbench.collaboration.interfaces.dto;

import java.util.List;

/**
 * 模块：设备数据传输对象集 (DeviceDtos)
 *
 * <p>【功能定义】
 * 定义本机设备注册、列表与吊销的传输形态。
 * 敏感凭据脱敏：响应中只公开设备状态与哈希，绝不泄露原始密钥。
 * 旧的共享项目与 WSS 信令传输形态已随远程派发链路拆除（HC-211）。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceController、DeviceAppService。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class DeviceDtos {

    private DeviceDtos() {}

    /** 设备概要视图：设备属人（D11），不再携带 workspaceId */
    public record DeviceSummary(
            String deviceId,
            String ownerUserId,
            String name,
            String createdAt,
            String revokedAt,
            String connectionState,
            String lastSeenAt
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
}
