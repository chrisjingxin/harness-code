package workbench.collaboration.transport;

import workbench.collaboration.*;
import workbench.collaboration.identity.IdentityService;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

/** 身份传输只消费框架认证结果；作者由服务端内部 ID 确定，不接受正文指定操作人。 */
@RestController
public final class IdentityController {
  private final Contracts contracts;
  private final IdentityService identity;
  public IdentityController(Contracts contracts, IdentityService identity) { this.contracts = contracts; this.identity = identity; }
  @GetMapping(value = "/api/v1/auth/csrf", produces = "application/json")
  public String csrf(CsrfToken token) { return contracts.encode("CsrfResponse", new PlatformDtos.CsrfResponse(token.getHeaderName(), token.getToken())); }
  @GetMapping(value = "/api/v1/auth/demo-users", produces = "application/json")
  public String demoUsers() { return contracts.encode("DemoUsersResponse", identity.demoUsers()); }
  @GetMapping(value = "/api/v1/auth/me", produces = "application/json")
  public String me(Authentication auth) { return contracts.encode("CurrentUserResponse", identity.current(auth.getName())); }
  @GetMapping(value = "/api/v1/workspaces", produces = "application/json")
  public String workspaces(Authentication auth) { return contracts.encode("WorkspaceListResponse", identity.listWorkspaces(auth.getName())); }
  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/members", produces = "application/json")
  public String members(Authentication auth, @PathVariable String workspaceId) { return contracts.encode("MembersResponse", identity.members(auth.getName(), workspaceId)); }
}
