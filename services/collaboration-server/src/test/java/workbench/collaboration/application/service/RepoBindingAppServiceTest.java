package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.support.FakeStores;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.cache.MemoryDeviceHeartbeat;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.Digests;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.support.FakeStores.FakeBindings;
import workbench.collaboration.support.FakeStores.FakeDevices;
import workbench.collaboration.support.FakeStores.FakeIdentity;
import workbench.collaboration.support.FakeStores.FakeProjects;
import workbench.collaboration.support.FakeStores.FakeRepositories;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;

/**
 * 设备本机仓库登记核对：Bearer 凭据认证、归档拒绝、
 * owner 团队成员资格、幂等 upsert 与解除语义。
 */
class RepoBindingAppServiceTest {

    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final String OWNER = "11111111111141118111111111111111";
    private static final String OUTSIDER = "99999999999949998999999999999999";
    private static final String REPO = "77777777-7777-4777-8777-777777777777";
    private static final String DEVICE = "33333333-3333-4333-8333-333333333333";
    private static final String SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    private final FakeIdentity identity = new FakeIdentity();
    private final FakeDevices devices = new FakeDevices();
    private final FakeRepositories repositories = new FakeRepositories();
    private final FakeBindings bindings = new FakeBindings();
    private RepoBindingAppService service;

    @BeforeEach
    void setUp() {
        identity.users.put(OWNER, FakeStores.user(OWNER, "80278667", "负责人", true));
        identity.users.put(OUTSIDER, FakeStores.user(OUTSIDER, "80278669", "外人", true));
        identity.addMember(WS, OWNER);
        repositories.items.put(REPO, new Repository(
                REPO, WS, "中台服务", "git@example.com:team/middle.git", "main",
                RepositoryStatus.ACTIVE, OWNER, 1L, 1L));
        devices.items.put(DEVICE, new Device(
                DEVICE, OWNER, "inst", "ledger", "本机", Digests.sha256Hex(SECRET),
                "reg", "body", false, 1L, 1L));

        IdentityAppService identityService = mock(IdentityAppService.class);
        doNothing().when(identityService).requireMember(any(), any());
        DeviceAppService deviceService = new DeviceAppService(
                devices, identityService, new MemoryIdempotency(), new MemoryDeviceHeartbeat(), new Contracts());
        service = new RepoBindingAppService(
                deviceService, repositories, bindings,
                new ProjectAccessPolicy(identity, new FakeProjects(), repositories));
    }

    @Test
    void 登记幂等且解除后再次解除404() {
        service.bind(auth(), REPO);
        service.bind(auth(), REPO); // upsert 幂等
        assertThat(bindings.items).hasSize(1);

        service.unbind(auth(), REPO);
        assertThat(bindings.items).isEmpty();
        assertThatThrownBy(() -> service.unbind(auth(), REPO))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 仓库不存在404已归档409() {
        assertThatThrownBy(() -> service.bind(auth(), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);

        repositories.items.put("archived", new Repository(
                "archived", WS, "旧库", "git@example.com:team/old.git", "main",
                RepositoryStatus.ARCHIVED, OWNER, 1L, 1L));
        assertThatThrownBy(() -> service.bind(auth(), "archived"))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "REPOSITORY_ARCHIVED");
    }

    @Test
    void 设备owner非仓库团队成员被拒403() {
        devices.items.put("dev-outsider", new Device(
                "dev-outsider", OUTSIDER, "i", "l", "外人的机", Digests.sha256Hex(SECRET),
                "r", "b", false, 1L, 1L));
        assertThatThrownBy(() -> service.bind("Bearer dev-outsider." + SECRET, REPO))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(403, "DEVICE_FORBIDDEN");
    }

    @Test
    void 坏凭据与吊销设备一律401() {
        assertThatThrownBy(() -> service.bind("Bearer " + DEVICE + ".wrongwrongwrongwrongwrongwrongwrongwrongwrongwrong", REPO))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(401);
        devices.items.put("revoked-dev", new Device(
                "revoked-dev", OWNER, "i", "l", "已吊销", Digests.sha256Hex(SECRET),
                "r", "b", true, 1L, 1L));
        assertThatThrownBy(() -> service.bind("Bearer revoked-dev." + SECRET, REPO))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(401);
    }

    private static String auth() {
        return "Bearer " + DEVICE + "." + SECRET;
    }
}
