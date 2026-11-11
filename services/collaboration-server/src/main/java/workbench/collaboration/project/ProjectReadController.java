package workbench.collaboration.project;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.Contracts;
import workbench.collaboration.transport.ApiProblem;

/** 当前会话的具名项目只读入口，认证信息和项目目标均由服务端提供。 */
@RestController
public final class ProjectReadController {
  private final Contracts contracts;
  private final ProjectReadService service;
  private final JsonMapper mapper = JsonMapper.builder().build();

  public ProjectReadController(Contracts contracts, ProjectReadService service) {
    this.contracts = contracts; this.service = service;
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/project/read",
    consumes = "application/json", produces = "application/json")
  public String read(Authentication authentication, HttpServletRequest request, @PathVariable String workspaceId,
                     @PathVariable String conversationId, @RequestBody String body) {
    if (!contracts.valid("ProjectReadAction", body)) throw new ApiProblem(400, "INVALID_REQUEST");
    HttpSession session = request.getSession(false);
    if (session == null || session.getAccessor() == null) throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
    Object started = request.getAttribute("workbench.requestStarted");
    long startedAt = started instanceof Long value ? value : System.nanoTime();
    return service.read(authentication.getName(), workspaceId, conversationId, mapper.readTree(body), session.getAccessor(), startedAt);
  }
}
