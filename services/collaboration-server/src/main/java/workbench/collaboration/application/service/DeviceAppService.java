package workbench.collaboration.application.service;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceHeartbeatPort;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.Digests;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.DeviceDtos;

import java.util.List;
import java.util.Optional;

/**
 * 模块：设备管理应用服务 (DeviceAppService)
 *
 * <p>【功能定义】
 * 负责本机执行设备的注册入网、基于 Token 的安全认证与设备吊销。
 * HC-211 起设备属于用户本人（D11）：注册要求调用者是目标团队成员，
 * 设备列表与吊销均按 owner 维度收口；在线状态仅由 HTTPS 心跳键驱动展示。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceController、ConversationSyncAppService、RepoBindingAppService。
 * - 下游依赖方：DeviceRepository、IdentityAppService、IdempotencyPort、DeviceHeartbeatPort、Contracts。
 */
@Service
public class DeviceAppService {

    private final DeviceRepository devices;
    private final IdentityAppService identity;
    private final IdempotencyPort idempotency;
    private final DeviceHeartbeatPort heartbeats;
    private final Contracts contracts;

    public DeviceAppService(
            DeviceRepository devices,
            IdentityAppService identity,
            IdempotencyPort idempotency,
            DeviceHeartbeatPort heartbeats,
            Contracts contracts
    ) {
        this.devices = devices;
        this.identity = identity;
        this.idempotency = idempotency;
        this.heartbeats = heartbeats;
        this.contracts = contracts;
    }

    /**
     * 注册新的本机设备档案。
     *
     * <p>【安全与幂等机制 (Why)】
     * - 设备访问密钥只在数据库持久化其 SHA-256 哈希摘要，严禁明文凭据入库；
     * - 若该 deviceId 已存在且注册请求完全相同（相同 registrationId 与正文哈希），作为重试安全放行；
     * - 若被其他请求冲突占用则返回 409 REGISTRATION_CONFLICT。
     *
     * @param userId 注册用户标识
     * @param workspaceId 调用方所在工作区标识（仅作成员资格门槛）
     * @param rawBody 注册请求原始 JSON 报文
     * @return 注册结果 JSON 响应
     */
    @Transactional
    public String register(String userId, String workspaceId, String rawBody) {
        identity.requireMember(workspaceId, userId);
        DeviceDtos.DeviceRegistrationRequest request = contracts.decode(
                "DeviceRegistrationRequest",
                rawBody,
                DeviceDtos.DeviceRegistrationRequest.class
        );
        String fingerprint = IdempotentCalls.fingerprint(rawBody);

        return IdempotentCalls.run(idempotency, workspaceId, userId, "device.register", request.registrationId(), fingerprint, () -> {
            String bodyHash = Digests.sha256Hex(rawBody);
            String secretHash = Digests.sha256Hex(request.secret());
            Optional<Device> existing = devices.findById(request.deviceId());
            if (existing.isPresent()) {
                Device device = existing.get();
                // 相同注册凭证的重放安全返回已有结果
                if (device.registrationId().equals(request.registrationId()) && device.registrationBodySha256().equals(bodyHash)) {
                    return encode(device, workspaceId, request.registrationId());
                }
                throw new ApiProblem(409, "REGISTRATION_CONFLICT");
            }

            long now = System.currentTimeMillis();
            Device device = new Device(
                    request.deviceId(),
                    userId,
                    request.installationId(),
                    request.ledgerId(),
                    request.name(),
                    secretHash,
                    request.registrationId(),
                    bodyHash,
                    false,
                    now,
                    now
            );
            try {
                devices.insert(device);
            } catch (DuplicateKeyException conflict) {
                throw new ApiProblem(409, "REGISTRATION_CONFLICT");
            }
            return encode(device, workspaceId, request.registrationId());
        });
    }

    /**
     * 校验来自设备的 Bearer Token 凭证（格式："Bearer {deviceId}.{secret}"）。
     *
     * @param header Authorization 报文头
     * @return 认证通过的 Device 实体
     * @throws ApiProblem 401 DEVICE_AUTHENTICATION_REQUIRED 凭据不全、设备已吊销或密钥哈希不匹配时
     */
    @Transactional(readOnly = true)
    public Device authenticate(String header) {
        if (header == null || !header.startsWith("Bearer ")) {
            throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
        }
        String token = header.substring("Bearer ".length());
        int split = token.indexOf('.');
        if (split <= 0 || split == token.length() - 1) {
            throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
        }
        Device device = devices.findById(token.substring(0, split))
                .orElseThrow(() -> new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED"));
        // 校验设备是否已被所有者吊销，以及传入密钥的 SHA-256 是否完全匹配库内摘要
        if (device.revoked() || !Digests.sha256Hex(token.substring(split + 1)).equals(device.secretSha256())) {
            throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
        }
        return device;
    }

    /**
     * 吊销禁用指定设备（立即失效其凭据并清除在线展示）。
     * 仅设备所有者本人可吊销。
     *
     * @param userId 操作用户标识
     * @param workspaceId 调用方所在工作区标识（仅作成员资格门槛）
     * @param deviceId 目标设备标识
     * @param rawBody 请求报文
     * @return 吊销确认响应 JSON
     */
    @Transactional
    public String revoke(String userId, String workspaceId, String deviceId, String rawBody) {
        identity.requireMember(workspaceId, userId);
        DeviceDtos.DeviceRevokeRequest request = contracts.decode(
                "DeviceRevokeRequest",
                rawBody,
                DeviceDtos.DeviceRevokeRequest.class
        );

        return IdempotentCalls.run(idempotency, workspaceId, userId, "device.revoke", request.requestId(), IdempotentCalls.fingerprint(deviceId, rawBody), () -> {
            Device device = devices.findById(deviceId)
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
            // 权限防护：只有设备所有者本人允许吊销
            if (!device.ownerUserId().equals(userId)) {
                throw new ApiProblem(403, "DEVICE_ACTION_REJECTED");
            }
            long now = System.currentTimeMillis();
            Device revoked = new Device(
                    device.id(),
                    device.ownerUserId(),
                    device.installationId(),
                    device.ledgerId(),
                    device.name(),
                    device.secretSha256(),
                    device.registrationId(),
                    device.registrationBodySha256(),
                    true,
                    device.createdAtMs(),
                    now
            );
            devices.update(revoked);
            // 清除在线心跳键，设备立即转为离线展示
            heartbeats.remove(device.id());
            return contracts.encode("DeviceRevokedResponse", new DeviceDtos.DeviceRevokedResponse(device.id(), TimeCodec.utc(now)));
        });
    }

    /**
     * 分页列出调用者本人已登记的设备档案。
     *
     * @param userId 调用用户标识
     * @param workspaceId 工作区标识（仅作成员资格门槛）
     * @param beforeCreatedAt 游标时间戳
     * @param beforeId 游标辅助标识
     * @param limit 每页限制
     * @return 分页设备列表响应 JSON
     */
    @Transactional(readOnly = true)
    public String listDevices(String userId, String workspaceId, String beforeCreatedAt, String beforeId, int limit) {
        identity.requireMember(workspaceId, userId);
        Long beforeMs = beforeCreatedAt == null ? null : TimeCodec.epoch(beforeCreatedAt);
        List<Device> found = devices.listByOwner(userId, beforeMs, beforeId, limit + 1);
        boolean more = found.size() > limit;
        if (more) {
            found = found.subList(0, limit);
        }
        DeviceDtos.DevicePageCursor cursor = more
                ? new DeviceDtos.DevicePageCursor(TimeCodec.utc(found.getLast().createdAtMs()), found.getLast().id())
                : null;
        return contracts.encode("DeviceListResponse", new DeviceDtos.DeviceListResponse(
                workspaceId,
                found.stream().map(device -> summary(workspaceId, device)).toList(),
                cursor
        ));
    }

    private String encode(Device device, String workspaceId, String registrationId) {
        return contracts.encode(
                "DeviceRegistrationResponse",
                new DeviceDtos.DeviceRegistrationResponse(registrationId, summary(workspaceId, device))
        );
    }

    private DeviceDtos.DeviceSummary summary(String workspaceId, Device device) {
        Optional<Long> seen = heartbeats.lastSeen(device.id());
        return new DeviceDtos.DeviceSummary(
                device.id(),
                workspaceId,
                device.ownerUserId(),
                device.name(),
                TimeCodec.utc(device.createdAtMs()),
                device.revoked() ? TimeCodec.utc(device.updatedAtMs()) : null,
                seen.isPresent() ? "online" : "offline",
                seen.map(TimeCodec::utc).orElse(null)
        );
    }
}
