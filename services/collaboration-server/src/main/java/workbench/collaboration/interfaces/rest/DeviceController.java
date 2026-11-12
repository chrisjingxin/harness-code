package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.DeviceAppService;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：设备管理 REST 控制器 (DeviceController)
 *
 * <p>【功能定义】
 * 设备生命周期管理端点（用户 Session 认证）：
 * 注册新设备、分页查看本人设备列表、吊销设备。
 * 设备属于用户本人；workspaceId 路径参数仅作团队成员资格门槛。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面工作台。
 * - 下游依赖方：DeviceAppService、CurrentSession、ApiResponses。
 */
@RestController
public class DeviceController {

    private final DeviceAppService devices;

    public DeviceController(DeviceAppService devices) {
        this.devices = devices;
    }

    /**
     * 用户将一台新的本机设备登记至协作平台。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/devices")
    public ResponseEntity<String> register(@PathVariable String workspaceId, @RequestBody String body) {
        return ApiResponses.json(201, devices.register(CurrentSession.userId(), workspaceId, body));
    }

    /**
     * 用户分页查看本人已登记的设备列表。
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
     * 用户吊销指定设备（仅设备所有者本人）。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/devices/{deviceId}/revoke")
    public ResponseEntity<String> revoke(@PathVariable String workspaceId, @PathVariable String deviceId, @RequestBody String body) {
        return ApiResponses.json(200, devices.revoke(CurrentSession.userId(), workspaceId, deviceId, body));
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
