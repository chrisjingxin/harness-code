package workbench.collaboration.infrastructure.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.session.ChangeSessionIdAuthenticationStrategy;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.IdentityAppService;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.dto.PlatformDtos;
import workbench.collaboration.interfaces.filter.BoundaryFilter;
import workbench.collaboration.interfaces.http.RouteCatalog;

import java.util.List;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 已登录不能再换人。不存在或停用的演示账号保持 401，不把响应写成 500。 */
class DemoLoginFilterTest {
  private static final String ORIGIN = "http://127.0.0.1:18084";
  private static final String USER = "11111111111141118111111111111111";
  private final IdentityAppService identity = mock(IdentityAppService.class);
  private MockMvc mvc;

  @BeforeEach
  void setUp() {
    Contracts contracts = new Contracts();
    var login = new WebSecurityConfig.DemoLoginFilter(identity, contracts);
    login.setSecurityContextRepository(new HttpSessionSecurityContextRepository());
    login.setSessionAuthenticationStrategy(new ChangeSessionIdAuthenticationStrategy());
    mvc = MockMvcBuilders.standaloneSetup(new Empty())
      .addFilters(new BoundaryFilter(contracts, new RouteCatalog(), ORIGIN, "127.0.0.1:18084"), login)
      .build();
  }

  @AfterEach
  void clear() { SecurityContextHolder.clearContext(); }

  @Test
  void loginReturnsTheCurrentUser() throws Exception {
    when(identity.authenticate("80278667")).thenReturn(USER);
    when(identity.current(USER)).thenReturn(new PlatformDtos.CurrentUserResponse(
      new PlatformDtos.UserSummary(USER, "80278667", "沈北辰", "", "org-004", "100004", "平台架构二组", "信息技术部/架构管理团队/零售应用架构四室/平台架构二组"),
      List.of()));
    mvc.perform(post("/api/v1/auth/demo-login").session(new MockHttpSession()).headers(headers()).contentType("application/json").content("{\"userNo\":\"80278667\"}"))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.body.user.userNo").value("80278667"))
      .andExpect(jsonPath("$.body.user.userName").value("沈北辰"));
  }

  @Test
  void secondLoginAndUnknownUserAreRejected() throws Exception {
    SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(USER, null, List.of()));
    mvc.perform(post("/api/v1/auth/demo-login").session(new MockHttpSession()).headers(headers()).contentType("application/json").content("{\"userNo\":\"80278668\"}"))
      .andExpect(status().is(409)).andExpect(jsonPath("$.body.code").value("ALREADY_AUTHENTICATED"));
    SecurityContextHolder.clearContext();
    when(identity.authenticate("missing01")).thenThrow(new workbench.collaboration.interfaces.ApiProblem(401, "DEMO_LOGIN_REJECTED"));
    mvc.perform(post("/api/v1/auth/demo-login").session(new MockHttpSession()).headers(headers()).contentType("application/json").content("{\"userNo\":\"missing01\"}"))
      .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.body.code").value("DEMO_LOGIN_REJECTED"));
  }

  private static org.springframework.http.HttpHeaders headers() {
    org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
    headers.set("Host", "127.0.0.1:18084");
    headers.set("Origin", ORIGIN);
    headers.set("X-Workbench-Protocol-Version", "1");
    return headers;
  }

  @RestController
  static class Empty {}
}
