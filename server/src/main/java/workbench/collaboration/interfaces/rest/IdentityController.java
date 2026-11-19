package workbench.collaboration.interfaces.rest;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.IdentityAppService;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.Foundation;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.dto.PlatformDtos;

import java.io.IOException;
import java.io.StringReader;
import java.util.Properties;

/**
 * 模块：身份与系统元数据 REST 控制器 (IdentityController)
 *
 * <p>【功能定义】
 * 提供服务元信息查询 (/api/v1/meta)、健康探测 (/health)、CSRF 防伪令牌获取 (/api/v1/auth/csrf)、
 * 演示账号列表 (/api/v1/auth/demo-users)、当前用户详情 (/api/v1/auth/me) 以及工作区与成员列表查询接口。
 *
 * <p>【协作边界】
 * - 上游调用方：前端工作台界面。
 * - 下游依赖方：IdentityAppService、Foundation、Contracts、ApiResponses。
 */
@RestController
public class IdentityController {

    private final Foundation foundation;
    private final Contracts contracts;
    private final IdentityAppService identity;
    private final String version;

    public IdentityController(Foundation foundation, Contracts contracts, IdentityAppService identity) {
        this.foundation = foundation;
        this.contracts = contracts;
        this.identity = identity;
        Properties properties = new Properties();
        try {
            properties.load(new StringReader(contracts.resource("build.properties")));
        } catch (IOException e) {
            throw new IllegalStateException("构建版本缺失", e);
        }
        version = properties.getProperty("productVersion");
        if (version == null || version.isBlank()) {
            throw new IllegalStateException("构建版本缺失");
        }
    }

    /**
     * 获取服务元信息（产品版本、协议版本、登录模式）。
     */
    @GetMapping("/api/v1/meta")
    public ResponseEntity<String> meta() {
        return ApiResponses.json(200, contracts.encode("MetaResponse", new PlatformDtos.MetaResponse(version, 1, "demo")));
    }

    /**
     * 容器健康探测端点（ping 探测底层数据库连通性）。
     */
    @GetMapping("/health")
    public ResponseEntity<String> health() {
        try {
            foundation.ping();
            return ApiResponses.json(200, contracts.encode("HealthResponse", new PlatformDtos.HealthResponse("UP")));
        } catch (org.springframework.dao.DataAccessException e) {
            return ApiResponses.json(503, contracts.encode("HealthResponse", new PlatformDtos.HealthResponse("DOWN")));
        }
    }

    /**
     * 获取当前会话的 CSRF 防伪令牌。
     */
    @GetMapping("/api/v1/auth/csrf")
    public ResponseEntity<String> csrf(HttpServletRequest request) {
        CsrfToken token = (CsrfToken) request.getAttribute(CsrfToken.class.getName());
        if (token == null) {
            token = (CsrfToken) request.getAttribute("_csrf");
        }
        return ApiResponses.json(200, contracts.encode("CsrfResponse", new PlatformDtos.CsrfResponse("X-CSRF-TOKEN", token.getToken())));
    }

    /**
     * 列出系统中可用的演示登录账号。
     */
    @GetMapping("/api/v1/auth/demo-users")
    public ResponseEntity<String> demoUsers() {
        return ApiResponses.json(200, contracts.encode("DemoUsersResponse", identity.demoUsers()));
    }

    /**
     * 获取当前登录用户的详细个人资料及所在工作区。
     */
    @GetMapping("/api/v1/auth/me")
    public ResponseEntity<String> me() {
        return ApiResponses.json(200, contracts.encode("CurrentUserResponse", identity.current(CurrentSession.userId())));
    }

    /**
     * 列出当前用户加入的所有工作区。
     */
    @GetMapping("/api/v1/workspaces")
    public ResponseEntity<String> workspaces() {
        return ApiResponses.json(200, contracts.encode("WorkspaceListResponse", identity.workspaces(CurrentSession.userId())));
    }

    /**
     * 列出指定工作区下的所有成员列表。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/members")
    public ResponseEntity<String> members(@PathVariable String workspaceId) {
        return ApiResponses.json(200, contracts.encode("MembersResponse", identity.members(CurrentSession.userId(), workspaceId)));
    }
}
