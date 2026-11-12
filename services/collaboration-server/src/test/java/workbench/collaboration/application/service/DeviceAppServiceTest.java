package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.infrastructure.cache.MemoryDeviceHeartbeat;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 设备属人登记、心跳在线展示与吊销。秘密只留哈希，非所有者吊销被拒。 */
class DeviceAppServiceTest {
  private static final JsonMapper JSON = JsonMapper.builder().build();
  private static final String USER = "11111111-1111-4111-8111-111111111111";
  private static final String OTHER = "99999999-9999-4999-8999-999999999999";
  private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
  private static final String DEVICE = "33333333-3333-4333-8333-333333333333";
  private static final String SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

  private final DeviceRepository repository = mock(DeviceRepository.class);
  private final IdentityAppService identity = mock(IdentityAppService.class);
  private final MemoryDeviceHeartbeat heartbeats = new MemoryDeviceHeartbeat();
  private final AtomicReference<Device> device = new AtomicReference<>();
  private DeviceAppService service;

  @BeforeEach
  void setUp() {
    doNothing().when(identity).requireMember(any(), any());
    doAnswer(invocation -> { device.set(invocation.getArgument(0)); return null; }).when(repository).insert(any());
    doAnswer(invocation -> { device.set(invocation.getArgument(0)); return null; }).when(repository).update(any());
    when(repository.findById(any())).thenAnswer(invocation ->
      Optional.ofNullable(device.get()).filter(found -> found.id().equals(invocation.getArgument(0))));
    when(repository.listByOwner(any(), any(), any(), anyInt())).thenAnswer(invocation ->
      device.get() == null ? List.of() : List.of(device.get()));
    service = new DeviceAppService(repository, identity, new MemoryIdempotency(), heartbeats, new Contracts());
  }

  @Test
  void registerThenHeartbeatFlipsTheDeviceOnline() {
    String registered = service.register(USER, WORKSPACE, registration("66666666-6666-4666-8666-666666666666"));
    var deviceJson = JSON.readTree(registered).path("device");
    assertThat(deviceJson.path("connectionState").asString()).isEqualTo("offline");
    assertThat(deviceJson.path("ownerUserId").asString()).isEqualTo(USER);
    assertThat(device.get().ownerUserId()).isEqualTo(USER);

    heartbeats.beat(DEVICE, System.currentTimeMillis());
    String listed = service.listDevices(USER, WORKSPACE, null, null, 50);
    var summary = JSON.readTree(listed).path("devices").get(0);
    assertThat(summary.path("connectionState").asString()).isEqualTo("online");
    assertThat(summary.path("lastSeenAt").isNull()).isFalse();
    assertThat(JSON.readTree(listed).path("nextPage").isNull()).isTrue();
  }

  @Test
  void registerReplayReturnsSameReceiptAndConflictingBodyIsRejected() {
    String registrationId = "77777777-7777-4777-8777-777777777777";
    String first = service.register(USER, WORKSPACE, registration(registrationId));
    String replay = service.register(USER, WORKSPACE, registration(registrationId));
    assertThat(replay).isEqualTo(first);
    assertThatThrownBy(() -> service.register(OTHER, WORKSPACE,
      registration("88888888-8888-4888-8888-888888888888").replace("冒烟设备", "抢占设备")))
      .isInstanceOf(ApiProblem.class).extracting("code").isEqualTo("REGISTRATION_CONFLICT");
  }

  @Test
  void revokeClearsHeartbeatAndOnlyTheOwnerMayRevoke() {
    service.register(USER, WORKSPACE, registration("66666666-6666-4666-8666-666666666666"));
    heartbeats.beat(DEVICE, System.currentTimeMillis());

    assertThatThrownBy(() -> service.revoke(OTHER, WORKSPACE, DEVICE, "{\"requestId\":\"99999999-9999-4999-8999-999999999999\"}"))
      .isInstanceOf(ApiProblem.class).extracting("status", "code").containsExactly(403, "DEVICE_ACTION_REJECTED");

    String revoked = service.revoke(USER, WORKSPACE, DEVICE, "{\"requestId\":\"99999999-9999-4999-8999-999999999999\"}");
    assertThat(JSON.readTree(revoked).path("deviceId").asString()).isEqualTo(DEVICE);
    assertThat(device.get().revoked()).isTrue();
    assertThat(heartbeats.lastSeen(DEVICE)).isEmpty();
  }

  @Test
  void authenticateRejectsRevokedOrWrongSecret() {
    service.register(USER, WORKSPACE, registration("66666666-6666-4666-8666-666666666666"));
    assertThat(service.authenticate("Bearer " + DEVICE + "." + SECRET).id()).isEqualTo(DEVICE);
    assertThatThrownBy(() -> service.authenticate("Bearer " + DEVICE + ".wrongsecretwrongsecretwrongsecretwrongsecre"))
      .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(401);
    service.revoke(USER, WORKSPACE, DEVICE, "{\"requestId\":\"99999999-9999-4999-8999-999999999999\"}");
    assertThatThrownBy(() -> service.authenticate("Bearer " + DEVICE + "." + SECRET))
      .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(401);
  }

  private static String registration(String registrationId) {
    return "{\"registrationId\":\"" + registrationId + "\",\"deviceId\":\"" + DEVICE + "\",\"installationId\":\"" + DEVICE
      + "\",\"ledgerId\":\"" + DEVICE + "\",\"name\":\"冒烟设备\",\"secret\":\"" + SECRET + "\"}";
  }
}
