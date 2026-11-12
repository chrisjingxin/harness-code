package workbench.collaboration.application.service;

import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 停用账号和外人不能靠旧会话继续访问。成员不存在和工作区不存在返回同一个 404。 */
class IdentityAppServiceTest {
  private final IdentityRepository repository = mock(IdentityRepository.class);
  private final IdentityAppService service = new IdentityAppService(repository);

  @Test
  void disabledOrMissingUserCannotSignIn() {
    when(repository.findUserByUsername("missing01")).thenReturn(Optional.empty());
    when(repository.findUserByUsername("user03")).thenReturn(Optional.of(user(false)));
    assertThatThrownBy(() -> service.authenticate("missing01")).isInstanceOf(ApiProblem.class)
      .extracting("status", "code").containsExactly(401, "DEMO_LOGIN_REJECTED");
    assertThatThrownBy(() -> service.authenticate("user03")).isInstanceOf(ApiProblem.class)
      .extracting("code").isEqualTo("DEMO_LOGIN_REJECTED");
  }

  @Test
  void outsiderAndUnknownWorkspaceLookTheSame() {
    when(repository.findUserById("user")).thenReturn(Optional.of(user(true)));
    when(repository.memberExists("ws", "user")).thenReturn(false);
    assertThatThrownBy(() -> service.requireMember("ws", "user")).isInstanceOf(ApiProblem.class)
      .extracting("status", "code").containsExactly(404, "RESOURCE_NOT_FOUND");
  }

  @Test
  void disabledCurrentUserIsSignedOut() {
    when(repository.findUserById("user")).thenReturn(Optional.of(user(false)));
    assertThatThrownBy(() -> service.requireUser("user")).isInstanceOf(ApiProblem.class)
      .extracting("code").isEqualTo("AUTHENTICATION_REQUIRED");
  }

  private static User user(boolean enabled) {
    return new User("11111111-1111-4111-8111-111111111111", "user01", "用户 01", enabled, 1);
  }
}
