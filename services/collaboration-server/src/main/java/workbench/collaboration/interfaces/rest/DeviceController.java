package workbench.collaboration.interfaces.rest;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.DeviceAppService;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：设备与项目管理 REST 控制器 (DeviceController)
 *
 * <p>【功能定义】
 * 区分“人类用户视角”与“设备守护进程视角”的设备和项目管理端点：
 * - 用户通道（Session 认证）：注册新设备、查询设备与项目列表、吊销设备、关闭项目共享；
 * - 设备通道（Bearer Token 认证）：由物理设备自主发布代码项目的最新共享状态与可用 Agent 配置。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面工作台、Electron Daemon 本机守护进程。
 * - 下游依赖方：DeviceAppService、CurrentSession、ApiResponses。
 */
@RestController
public class DeviceController {

    private final DeviceAppService devices;

    public DeviceController(DeviceAppService devices) {
        this.devices = devices;
    }

    /**
     * 用户将一台新的 Electron 本机设备登记至指定工作区。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/devices")
    public ResponseEntity<String> register(@PathVariable String workspaceId, @RequestBody String body) {
        return ApiResponses.json(201, devices.register(CurrentSession.userId(), workspaceId, body));
    }

    /**
     * 用户分页查看工作区下已登记的设备列表。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/devices")
    public ResponseEntity<String> list(
            @PathVariable String workspaceId,
            @RequestParam(required = false) String beforeCreatedAt,
            @RequestParam(required = false) String beforeDeviceId,
            @RequestParam(required = false) String limit
    ) {
        return ApiResponses.json(200, devices.listDevices(CurrentSession.userId(), workspaceId, beforeCreatedAt, beforeDeviceId, limit(limit)));
    }

    /**
     * 用户分页查看指定设备对外开放的共享项目列表。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/devices/{deviceId}/projects")
    public ResponseEntity<String> projects(
            @PathVariable String workspaceId,
            @PathVariable String deviceId,
            @RequestParam(required = false) String beforeCreatedAt,
            @RequestParam(required = false) String beforeProjectId,
            @RequestParam(required = false) String limit
    ) {
        return ApiResponses.json(200, devices.listProjects(CurrentSession.userId(), workspaceId, deviceId, beforeCreatedAt, beforeProjectId, limit(limit)));
    }

    /**
     * 用户吊销指定设备。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/devices/{deviceId}/revoke")
    public ResponseEntity<String> revoke(@PathVariable String workspaceId, @PathVariable String deviceId, @RequestBody String body) {
        return ApiResponses.json(200, devices.revoke(CurrentSession.userId(), workspaceId, deviceId, body));
    }

    /**
     * 用户停止项目的跨端共享。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/stop-sharing")
    public ResponseEntity<String> stopSharing(@PathVariable String workspaceId, @PathVariable String projectId, @RequestBody String body) {
        return ApiResponses.json(200, devices.stopSharing(CurrentSession.userId(), workspaceId, projectId, body));
    }

    /**
     * 由 Electron Daemon 凭其 Bearer 密钥向服务端发布代码项目的共享状态与配置。
     */
    @PostMapping("/api/v1/device/projects")
    public ResponseEntity<String> publish(HttpServletRequest request, @RequestBody String body) {
        Device device = devices.authenticate(request.getHeader("Authorization"));
        return ApiResponses.json(201, devices.publish(device, body));
    }

    private static int limit(String raw) {
        if (raw == null || raw.isEmpty()) {
            return 50;
        }
        int value = Integer.parseInt(raw);
        if (value < 1 || value > 100) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        return value;
    }
}
