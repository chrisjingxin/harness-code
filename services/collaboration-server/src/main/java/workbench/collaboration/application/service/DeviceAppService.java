package workbench.collaboration.application.service;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.device.DaemonPresence;
import workbench.collaboration.domain.device.DaemonPresencePort;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.device.SharedProject;
import workbench.collaboration.domain.execution.ExecutionStatePort;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.ExecutionCodec;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.DeviceDtos;
import workbench.collaboration.interfaces.dto.ExecutionDtos;

import java.util.List;
import java.util.Optional;

/**
 * 模块：设备管理与共享项目应用服务 (DeviceAppService)
 *
 * <p>【功能定义】
 * 负责 Electron 本机守护进程（Daemon）的设备注册入网、基于 Token 的安全认证、
 * 代码项目跨端共享配置发布、关闭共享、设备吊销，以及处理 Daemon 端主动推送的来源序号登记与指纹去重。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceController、DaemonWebSocketHandler、ConversationAppService。
 * - 下游依赖方：DeviceRepository、IdentityAppService、IdempotencyPort、DaemonPresencePort、ExecutionStatePort、Contracts。
 */
@Service
public class DeviceAppService {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final TypeReference<List<DeviceDtos.AgentConfigSummary>> CONFIGS = new TypeReference<>() {};

    private final DeviceRepository devices;
    private final IdentityAppService identity;
    private final IdempotencyPort idempotency;
    private final DaemonPresencePort presence;
    private final ExecutionStatePort executions;
    private final Contracts contracts;

    public DeviceAppService(
            DeviceRepository devices,
            IdentityAppService identity,
            IdempotencyPort idempotency,
            DaemonPresencePort presence,
            ExecutionStatePort executions,
            Contracts contracts
    ) {
        this.devices = devices;
        this.identity = identity;
        this.idempotency = idempotency;
        this.presence = presence;
        this.executions = executions;
        this.contracts = contracts;
    }

    /**
     * 注册新的 Electron Daemon 设备档案。
     *
     * <p>【安全与幂等机制 (Why)】
     * - 设备访问密钥只在数据库持久化其 SHA-256 哈希摘要，严禁明文凭据入库；
     * - 若该 deviceId 已存在且注册请求完全相同（相同 registrationId 与正文哈希），作为重试安全放行；
     * - 若被其他请求冲突占用则返回 409 REGISTRATION_CONFLICT。
     *
     * @param userId 注册用户标识
     * @param workspaceId 挂载工作区标识
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
            String bodyHash = ExecutionCodec.hex(rawBody);
            String secretHash = ExecutionCodec.hex(request.secret());
            Optional<Device> existing = devices.findById(request.deviceId());
            if (existing.isPresent()) {
                Device device = existing.get();
                // 相同注册凭证的重放安全返回已有结果
                if (device.registrationId().equals(request.registrationId()) && device.registrationBodySha256().equals(bodyHash)) {
                    return encode(device, request.registrationId());
                }
                throw new ApiProblem(409, "REGISTRATION_CONFLICT");
            }

            long now = System.currentTimeMillis();
            Device device = new Device(
                    request.deviceId(),
                    workspaceId,
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
            return encode(device, request.registrationId());
        });
    }

    /**
     * 校验来自 Daemon 的 Bearer Token 凭证（格式："Bearer {deviceId}.{secret}"）。
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
        // 校验设备是否已被管理员吊销，以及传入密钥的 SHA-256 是否完全匹配库内摘要
        if (device.revoked() || !ExecutionCodec.hex(token.substring(split + 1)).equals(device.secretSha256())) {
            throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
        }
        return device;
    }

    /**
     * 由 Daemon 设备对外发布或更新共享项目（支持 CAS 乐观锁版本并发保护）。
     *
     * @param device 已认证的设备实体
     * @param rawBody 发布请求报文
     * @return 保存后的共享项目响应 JSON
     */
    @Transactional
    public String publish(Device device, String rawBody) {
        DeviceDtos.DeviceProjectPublishRequest request = contracts.decode(
                "DeviceProjectPublishRequest",
                rawBody,
                DeviceDtos.DeviceProjectPublishRequest.class
        );
        String fingerprint = IdempotentCalls.fingerprint(device.id(), rawBody);

        return IdempotentCalls.run(idempotency, device.workspaceId(), device.id(), "project.publish", request.requestId(), fingerprint, () -> {
            long expected = version(request.expectedShareVersion());
            long now = System.currentTimeMillis();
            String configs = JSON.writeValueAsString(request.agentConfigs());
            Optional<SharedProject> current = devices.findProject(device.workspaceId(), request.projectId());
            SharedProject saved;

            if (current.isEmpty()) {
                // 首次发布期望版本必须为 0
                if (expected != 0) {
                    throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
                }
                saved = new SharedProject(
                        device.workspaceId(),
                        device.id(),
                        request.projectId(),
                        request.name(),
                        request.shareEnabled(),
                        1,
                        configs,
                        now
                );
                try {
                    devices.insertProject(saved);
                } catch (DuplicateKeyException conflict) {
                    throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
                }
            } else {
                SharedProject project = current.get();
                // 严禁非宿主设备越权修改项目配置，且当前版本号必须严格等于 expected
                if (!project.deviceId().equals(device.id()) || project.shareVersion() != expected) {
                    throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
                }
                saved = new SharedProject(
                        project.workspaceId(),
                        project.deviceId(),
                        project.projectId(),
                        request.name(),
                        request.shareEnabled(),
                        expected + 1,
                        configs,
                        now
                );
                // CAS 乐观锁更新，确保更新期间无其他请求抢先写入
                if (!devices.updateProjectIfVersion(saved, expected)) {
                    throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
                }
            }
            return contracts.encode("ProjectSavedResponse", new DeviceDtos.ProjectSavedResponse(request.requestId(), project(saved)));
        });
    }

    /**
     * 用户停止项目的对外共享。
     *
     * @param userId 操作用户标识
     * @param workspaceId 所属工作区标识
     * @param projectId 目标项目标识
     * @param rawBody 请求报文
     * @return 停止共享后的响应 JSON
     */
    @Transactional
    public String stopSharing(String userId, String workspaceId, String projectId, String rawBody) {
        identity.requireMember(workspaceId, userId);
        DeviceDtos.ProjectStopSharingRequest request = contracts.decode(
                "ProjectStopSharingRequest",
                rawBody,
                DeviceDtos.ProjectStopSharingRequest.class
        );
        String fingerprint = IdempotentCalls.fingerprint(projectId, rawBody);

        return IdempotentCalls.run(idempotency, workspaceId, userId, "project.stop", request.requestId(), fingerprint, () -> {
            SharedProject project = devices.findProject(workspaceId, projectId)
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
            long expected = version(request.expectedShareVersion());
            if (project.shareVersion() != expected) {
                throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
            }
            Device device = devices.findById(project.deviceId())
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
            // 权限防护：只有设备所有者本人允许停止该项目的共享
            if (!device.ownerUserId().equals(userId)) {
                throw new ApiProblem(403, "DEVICE_ACTION_REJECTED");
            }
            SharedProject stopped = new SharedProject(
                    project.workspaceId(),
                    project.deviceId(),
                    project.projectId(),
                    project.name(),
                    false,
                    expected + 1,
                    project.agentConfigsJson(),
                    System.currentTimeMillis()
            );
            if (!devices.updateProjectIfVersion(stopped, expected)) {
                throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
            }
            return contracts.encode("ProjectSavedResponse", new DeviceDtos.ProjectSavedResponse(request.requestId(), project(stopped)));
        });
    }

    /**
     * 吊销禁用指定设备（立即失效其凭据并剔除在线状态）。
     *
     * @param userId 操作用户标识
     * @param workspaceId 所属工作区标识
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
            Device device = requireOwned(userId, workspaceId, deviceId);
            long now = System.currentTimeMillis();
            Device revoked = new Device(
                    device.id(),
                    device.workspaceId(),
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
            // 立即从全局在线路由表中移除该设备，阻止后续一切 WebSocket 下发
            presence.remove(device.id());
            return contracts.encode("DeviceRevokedResponse", new DeviceDtos.DeviceRevokedResponse(device.id(), TimeCodec.utc(now)));
        });
    }

    /**
     * 分页列出工作区内已登记的设备档案。
     *
     * @param userId 调用用户标识
     * @param workspaceId 工作区标识
     * @param beforeCreatedAt 游标时间戳
     * @param beforeId 游标辅助标识
     * @param limit 每页限制
     * @return 分页设备列表响应 JSON
     */
    @Transactional(readOnly = true)
    public String listDevices(String userId, String workspaceId, String beforeCreatedAt, String beforeId, int limit) {
        identity.requireMember(workspaceId, userId);
        Long beforeMs = beforeCreatedAt == null ? null : TimeCodec.epoch(beforeCreatedAt);
        List<Device> found = devices.listByWorkspace(workspaceId, beforeMs, beforeId, limit + 1);
        boolean more = found.size() > limit;
        if (more) {
            found = found.subList(0, limit);
        }
        DeviceDtos.DevicePageCursor cursor = more
                ? new DeviceDtos.DevicePageCursor(TimeCodec.utc(found.getLast().createdAtMs()), found.getLast().id())
                : null;
        return contracts.encode("DeviceListResponse", new DeviceDtos.DeviceListResponse(
                workspaceId,
                found.stream().map(this::device).toList(),
                cursor
        ));
    }

    /**
     * 分页列出指定设备对外共享的项目列表。
     *
     * @param userId 调用用户标识
     * @param workspaceId 工作区标识
     * @param deviceId 设备标识
     * @param beforeCreatedAt 游标时间戳
     * @param beforeProjectId 游标项目标识
     * @param limit 每页限制
     * @return 分页项目列表响应 JSON
     */
    @Transactional(readOnly = true)
    public String listProjects(String userId, String workspaceId, String deviceId, String beforeCreatedAt, String beforeProjectId, int limit) {
        identity.requireMember(workspaceId, userId);
        requireVisible(workspaceId, deviceId);
        Long beforeMs = beforeCreatedAt == null ? null : TimeCodec.epoch(beforeCreatedAt);
        List<SharedProject> found = devices.listProjects(workspaceId, deviceId, beforeMs, beforeProjectId, limit + 1);
        boolean more = found.size() > limit;
        if (more) {
            found = found.subList(0, limit);
        }
        DeviceDtos.ProjectPageCursor cursor = more
                ? new DeviceDtos.ProjectPageCursor(TimeCodec.utc(found.getLast().updatedAtMs()), found.getLast().projectId())
                : null;
        return contracts.encode("ProjectListResponse", new DeviceDtos.ProjectListResponse(
                workspaceId,
                deviceId,
                found.stream().map(this::project).toList(),
                cursor
        ));
    }

    /**
     * 校验并记录 Daemon 推送批量事件的来源序号与内容指纹。
     *
     * @param deviceId 设备标识
     * @param connectionId WebSocket 连接通道标识
     * @param executionId 执行流水标识
     * @param sequence 本地来源序号
     * @param fingerprint 报文指纹
     * @return 确认回执 ExecutionAck
     */
    public ExecutionDtos.ExecutionAck recordBatch(String deviceId, String connectionId, String executionId, long sequence, String fingerprint) {
        recordSource(deviceId, connectionId, executionId, sequence, fingerprint);
        return new ExecutionDtos.ExecutionAck(executionId, Long.toString(sequence));
    }

    /**
     * 校验设备合法性、在线连接匹配度并登记事件指纹。
     *
     * @param deviceId 设备标识
     * @param connectionId 连接通道标识
     * @param executionId 执行标识
     * @param sequence 连续序号
     * @param fingerprint 内容哈希指纹
     * @return true 表示首次登记需处理；false 表示同指纹幂等重放
     */
    public boolean recordSource(String deviceId, String connectionId, String executionId, long sequence, String fingerprint) {
        Device device = devices.findById(deviceId)
                .orElseThrow(() -> new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED"));
        if (device.revoked()) {
            throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
        }
        DaemonPresence online = presence.find(deviceId)
                .orElseThrow(() -> new ApiProblem(409, "TARGET_UNAVAILABLE"));
        if (!online.connectionId().equals(connectionId)) {
            throw new ApiProblem(409, "TARGET_UNAVAILABLE");
        }
        try {
            return executions.rememberSource(executionId, sequence, fingerprint);
        } catch (IllegalStateException conflict) {
            throw new ApiProblem(409, "EXECUTION_STATE_CONFLICT");
        }
    }

    private Device requireOwned(String userId, String workspaceId, String deviceId) {
        Device device = requireVisible(workspaceId, deviceId);
        if (!device.ownerUserId().equals(userId)) {
            throw new ApiProblem(403, "DEVICE_ACTION_REJECTED");
        }
        return device;
    }

    private Device requireVisible(String workspaceId, String deviceId) {
        Device device = devices.findById(deviceId)
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        if (!device.workspaceId().equals(workspaceId)) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
        return device;
    }

    private String encode(Device device, String registrationId) {
        return contracts.encode(
                "DeviceRegistrationResponse",
                new DeviceDtos.DeviceRegistrationResponse(registrationId, device(device))
        );
    }

    private DeviceDtos.DeviceSummary device(Device device) {
        Optional<DaemonPresence> online = presence.find(device.id());
        String state = online.map(DaemonPresence::state).orElse("offline");
        String seen = online.map(row -> TimeCodec.utc(row.lastSeenMs())).orElse(null);
        return new DeviceDtos.DeviceSummary(
                device.id(),
                device.workspaceId(),
                device.ownerUserId(),
                device.name(),
                TimeCodec.utc(device.createdAtMs()),
                device.revoked() ? TimeCodec.utc(device.updatedAtMs()) : null,
                state,
                seen
        );
    }

    private DeviceDtos.ProjectSummary project(SharedProject project) {
        String when = TimeCodec.utc(project.updatedAtMs());
        return new DeviceDtos.ProjectSummary(
                project.projectId(),
                project.deviceId(),
                project.workspaceId(),
                project.name(),
                project.shareEnabled(),
                Long.toString(project.shareVersion()),
                when,
                when,
                JSON.readValue(project.agentConfigsJson(), CONFIGS)
        );
    }

    private static long version(String raw) {
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException e) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
    }
}
