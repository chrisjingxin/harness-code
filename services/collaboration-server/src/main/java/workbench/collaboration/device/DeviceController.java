package workbench.collaboration.device;

import workbench.collaboration.Contracts;
import workbench.collaboration.device.DeviceDtos.*;
import workbench.collaboration.transport.ApiProblem;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.*;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** 设备/项目 HTTP：浏览器身份走 HttpSession，Runner 只走独立 Bearer，两者不共用 Cookie。 */
@RestController
public final class DeviceController {
  private final Contracts contracts;
  private final DeviceService devices;
  private final DeviceChannel channel;
  public DeviceController(Contracts contracts, DeviceService devices, DeviceChannel channel) {
    this.contracts = contracts; this.devices = devices; this.channel = channel;
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/devices", consumes = "application/json", produces = "application/json")
  public ResponseEntity<String> register(Authentication auth, @PathVariable String workspaceId, @RequestBody String body) {
    DeviceRegistrationRequest request = contracts.decode("DeviceRegistrationRequest", body, DeviceRegistrationRequest.class);
    DeviceService.RegistrationOutcome outcome = devices.register(auth.getName(), workspaceId, request);
    return ResponseEntity.status(outcome.created() ? HttpStatus.CREATED : HttpStatus.OK)
      .body(contracts.encode("DeviceRegistrationResponse", outcome.response()));
  }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/devices", produces = "application/json")
  public String list(Authentication auth, @PathVariable String workspaceId,
                     @RequestParam(required = false) String limit,
                     @RequestParam(required = false) String beforeCreatedAt,
                     @RequestParam(required = false) String beforeDeviceId) {
    return contracts.encode("DeviceListResponse", devices.listDevices(auth.getName(), workspaceId, limit, beforeCreatedAt, beforeDeviceId));
  }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/devices/{deviceId}/projects", produces = "application/json")
  public String projects(Authentication auth, @PathVariable String workspaceId, @PathVariable String deviceId,
                         @RequestParam(required = false) String limit,
                         @RequestParam(required = false) String beforeCreatedAt,
                         @RequestParam(required = false) String beforeProjectId) {
    return contracts.encode("ProjectListResponse", devices.listProjects(auth.getName(), workspaceId, deviceId, limit, beforeCreatedAt, beforeProjectId));
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/devices/{deviceId}/revoke", consumes = "application/json", produces = "application/json")
  public String revoke(Authentication auth, @PathVariable String workspaceId, @PathVariable String deviceId, @RequestBody String body) {
    DeviceRevokeRequest request = contracts.decode("DeviceRevokeRequest", body, DeviceRevokeRequest.class);
    DeviceRevokedResponse revoked = devices.revoke(auth.getName(), workspaceId, deviceId, request);
    channel.deviceRevoked(revoked.deviceId());
    return contracts.encode("DeviceRevokedResponse", revoked);
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/projects/{projectId}/stop-sharing", consumes = "application/json", produces = "application/json")
  public String stopSharing(Authentication auth, @PathVariable String workspaceId, @PathVariable String projectId, @RequestBody String body) {
    ProjectStopSharingRequest request = contracts.decode("ProjectStopSharingRequest", body, ProjectStopSharingRequest.class);
    ProjectSavedResponse saved = devices.stopSharing(auth.getName(), workspaceId, projectId, request);
    channel.projectChanged(saved.project().deviceId());
    return contracts.encode("ProjectSavedResponse", saved);
  }

  /** 设备发布项目：所有者来自 Bearer 认证记录，不接受正文替换。 */
  @PostMapping(value = "/api/v1/device/projects", consumes = "application/json", produces = "application/json")
  public ResponseEntity<String> publish(HttpServletRequest http, @RequestBody String body) {
    AuthenticatedDevice device = authenticate(http);
    DeviceProjectPublishRequest request = contracts.decode("DeviceProjectPublishRequest", body, DeviceProjectPublishRequest.class);
    DeviceService.SavedOutcome outcome = devices.publish(device, request);
    channel.projectChanged(device.deviceId());
    return ResponseEntity.status(outcome.created() ? HttpStatus.CREATED : HttpStatus.OK)
      .body(contracts.encode("ProjectSavedResponse", outcome.response()));
  }

  private AuthenticatedDevice authenticate(HttpServletRequest request) {
    if (request.getHeader("Cookie") != null) throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
    return devices.authenticate(request.getHeader("Authorization"));
  }
}
