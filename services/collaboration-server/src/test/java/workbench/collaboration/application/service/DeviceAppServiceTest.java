package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.device.DaemonPresence;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.device.SharedProject;
import workbench.collaboration.infrastructure.cache.MemoryExecutionState;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.cache.MemoryPresence;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 登记、发布和 Daemon 来源序号。秘密只留哈希，相同指纹跳过，不同指纹拒绝。 */
class DeviceAppServiceTest {
  private static final JsonMapper JSON = JsonMapper.builder().build();
  private static final String USER = "11111111-1111-4111-8111-111111111111";
  private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
  private static final String DEVICE = "33333333-3333-4333-8333-333333333333";
  private static final String PROJECT = "44444444-4444-4444-8444-444444444444";
  private static final String AGENT = "55555555-5555-4555-8555-555555555555";
  private static final String SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

  private final DeviceRepository repository = mock(DeviceRepository.class);
  private final IdentityAppService identity = mock(IdentityAppService.class);
  private final MemoryPresence presence = new MemoryPresence();
  private final MemoryExecutionState executions = new MemoryExecutionState();
  private final AtomicReference<Device> device = new AtomicReference<>();
  private final AtomicReference<SharedProject> project = new AtomicReference<>();
  private DeviceAppService service;

  @BeforeEach
  void setUp() {
    doNothing().when(identity).requireMember(any(), any());
    doAnswer(invocation -> { device.set(invocation.getArgument(0)); return null; }).when(repository).insert(any());
    doAnswer(invocation -> { device.set(invocation.getArgument(0)); return null; }).when(repository).update(any());
    when(repository.findById(any())).thenAnswer(invocation -> Optional.ofNullable(device.get()).filter(found -> found.id().equals(invocation.getArgument(0))));
    when(repository.listByWorkspace(any(), any(), any(), anyInt())).thenAnswer(invocation -> device.get() == null ? List.of() : List.of(device.get()));
    doAnswer(invocation -> { project.set(invocation.getArgument(0)); return null; }).when(repository).insertProject(any());
    when(repository.findProject(any(), any())).thenAnswer(invocation -> Optional.ofNullable(project.get()));
    when(repository.listProjects(any(), any(), any(), any(), anyInt())).thenAnswer(invocation -> project.get() == null ? List.of() : List.of(project.get()));
    service = new DeviceAppService(repository, identity, new MemoryIdempotency(), presence, executions, new Contracts());
  }

  @Test
  void registerAndPublishEncodeTheOfflineDeviceAndVersionOne() {
    String registrationId = "66666666-6666-4666-8666-666666666666";
    String registered = service.register(USER, WORKSPACE, registration(registrationId));
    var deviceJson = JSON.readTree(registered).path("device");
    assertThat(deviceJson.path("connectionState").asString()).isEqualTo("offline");
    assertThat(deviceJson.path("revokedAt").isNull()).isTrue();
    assertThat(deviceJson.path("lastSeenAt").isNull()).isTrue();
    String requestId = "77777777-7777-4777-8777-777777777777";
    String published = service.publish(device.get(), publish(requestId));
    assertThat(JSON.readTree(published).path("project").path("shareVersion").asString()).isEqualTo("1");
    String listed = service.listDevices(USER, WORKSPACE, null, null, 50);
    assertThat(JSON.readTree(listed).path("nextPage").isNull()).isTrue();
    assertThat(JSON.readTree(listed).path("devices").get(0).path("deviceId").asString()).isEqualTo(DEVICE);
  }

  @Test
  void recordBatchSkipsTheSameFingerprintAndRejectsADifferentOne() {
    device.set(new Device(DEVICE, WORKSPACE, USER, DEVICE, DEVICE, "设备", "hash", DEVICE, "hash", false, 1, 1));
    presence.save(new DaemonPresence(DEVICE, "local", "socket-1", "ready", 1));
    var first = service.recordBatch(DEVICE, "socket-1", "88888888-8888-4888-8888-888888888888", 1, "fingerprint");
    var replay = service.recordBatch(DEVICE, "socket-1", "88888888-8888-4888-8888-888888888888", 1, "fingerprint");
    assertThat(replay).isEqualTo(first);
    assertThat(first.lastCommittedRunnerSequence()).isEqualTo("1");
    assertThatThrownBy(() -> service.recordBatch(DEVICE, "socket-1", "88888888-8888-4888-8888-888888888888", 1, "other"))
      .isInstanceOf(ApiProblem.class).extracting("status", "code").containsExactly(409, "EXECUTION_STATE_CONFLICT");
    assertThatThrownBy(() -> service.recordBatch(DEVICE, "other-socket", "88888888-8888-4888-8888-888888888888", 2, "fingerprint"))
      .isInstanceOf(ApiProblem.class).extracting("code").isEqualTo("TARGET_UNAVAILABLE");
    String revoked = service.revoke(USER, WORKSPACE, DEVICE, "{\"requestId\":\"99999999-9999-4999-8999-999999999999\"}");
    assertThat(JSON.readTree(revoked).path("deviceId").asString()).isEqualTo(DEVICE);
    assertThat(presence.find(DEVICE)).isEmpty();
  }

  private static String registration(String registrationId) {
    return "{\"registrationId\":\"" + registrationId + "\",\"deviceId\":\"" + DEVICE + "\",\"installationId\":\"" + DEVICE
      + "\",\"ledgerId\":\"" + DEVICE + "\",\"name\":\"冒烟设备\",\"secret\":\"" + SECRET + "\"}";
  }

  private static String publish(String requestId) {
    return "{\"requestId\":\"" + requestId + "\",\"projectId\":\"" + PROJECT + "\",\"name\":\"冒烟项目\",\"shareEnabled\":true,"
      + "\"expectedShareVersion\":\"0\",\"agentConfigs\":[{\"agentConfigId\":\"" + AGENT + "\",\"name\":\"受控执行配置\",\"available\":true}]}";
  }
}
