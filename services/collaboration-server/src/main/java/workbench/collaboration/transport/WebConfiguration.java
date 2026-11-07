package workbench.collaboration.transport;

import workbench.collaboration.*;
import workbench.collaboration.identity.IdentityService;
import workbench.collaboration.infrastructure.Foundation;
import javax.sql.DataSource;
import org.springframework.context.annotation.*;
import org.springframework.core.env.Environment;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.http.*;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.*;
import org.springframework.security.web.context.*;
import org.springframework.security.web.authentication.*;
import org.springframework.security.web.authentication.session.*;
import org.springframework.security.web.csrf.*;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 身份 HTTP 装配：来源/形状 → CSRF → Spring 认证与会话 → 启用状态/成员 → 安全 DTO。
 * Foundation 保留启动前校验；用户凭据只在 HttpSession，不建立角色或密码认证旁路。
 */
@Configuration(proxyBeanMethods = false)
@Import(IdentityController.class)
public class WebConfiguration {
  @Bean UserDetailsService noDefaultUsers() { return new InMemoryUserDetailsManager(); }
  @Bean IdentityService identityService(DataSource source) { return new IdentityService(source); }
  @Bean ServletContextInitializer sessionCookieSecurity(Environment env) {
    boolean secure = env.getRequiredProperty("workbench.origin").startsWith("https://");
    return context -> context.getSessionCookieConfig().setSecure(secure);
  }
  @Bean SecurityFilterChain security(HttpSecurity http, Foundation foundation, Contracts contracts, IdentityService identity, Environment env) throws Exception {
    String origin = env.getRequiredProperty("workbench.origin");
    URI uri = URI.create(origin);
    if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty()) ||
        !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())))) throw new IllegalArgumentException("服务 origin 无效");
    var contexts = new HttpSessionSecurityContextRepository();
    var csrf = new HttpSessionCsrfTokenRepository();
    var login = new DemoLoginFilter(identity);
    login.setSecurityContextRepository(contexts);
    login.setSessionAuthenticationStrategy(new CompositeSessionAuthenticationStrategy(List.of(new ChangeSessionIdAuthenticationStrategy(), new CsrfAuthenticationStrategy(csrf))));
    login.setAuthenticationSuccessHandler((request, response, auth) -> {
      response.getWriter().write(contracts.encode("CurrentUserResponse", identity.current(auth.getName())));
    });
    login.setAuthenticationFailureHandler((request, response, error) -> failure(contracts, request, response, 401, "DEMO_LOGIN_REJECTED"));
    return http.securityContext(c -> c.securityContextRepository(contexts))
      .requestCache(c -> c.disable())
      .csrf(c -> c.csrfTokenRepository(csrf))
      .authorizeHttpRequests(a -> a.requestMatchers("/health", "/api/v1/meta", "/api/v1/auth/csrf", "/api/v1/auth/demo-users", "/api/v1/auth/demo-login", "/api/v1/auth/logout").permitAll().anyRequest().authenticated())
      .exceptionHandling(h -> h.authenticationEntryPoint((request, response, e) -> failure(contracts, request, response, 401, "AUTHENTICATION_REQUIRED"))
        .accessDeniedHandler((request, response, e) -> failure(contracts, request, response, 403, e instanceof CsrfException ? "CSRF_INVALID" : "REQUEST_SOURCE_REJECTED")))
      .logout(l -> l.logoutRequestMatcher(request -> request.getMethod().equals("POST") && request.getRequestURI().equals("/api/v1/auth/logout"))
        .deleteCookies("WBSESSION").logoutSuccessHandler((request, response, auth) -> response.setStatus(204)))
      .addFilterBefore(new Boundary(contracts, origin, uri.getRawAuthority()), SecurityContextHolderFilter.class)
      .addFilterBefore(login, UsernamePasswordAuthenticationFilter.class).build();
  }

  /** 框架认证过滤器负责 session 策略和 context 持久化，控制器不自行设置 ThreadLocal。 */
  private static final class DemoLoginFilter extends AbstractAuthenticationProcessingFilter {
    DemoLoginFilter(IdentityService identity) {
      super(request -> request.getMethod().equals("POST") && request.getRequestURI().equals("/api/v1/auth/demo-login"));
      setAuthenticationManager(input -> UsernamePasswordAuthenticationToken.authenticated(identity.authenticate(input.getName()), null, List.of()));
    }
    @Override public Authentication attemptAuthentication(HttpServletRequest request, HttpServletResponse response) {
      Authentication existing = SecurityContextHolder.getContext().getAuthentication();
      if (existing != null && existing.isAuthenticated() && !(existing instanceof AnonymousAuthenticationToken)) throw new ApiProblem(409, "ALREADY_AUTHENTICATED");
      var input = (PlatformDtos.DemoLoginRequest) request.getAttribute("workbench.login");
      return getAuthenticationManager().authenticate(UsernamePasswordAuthenticationToken.unauthenticated(input.username(), null));
    }
  }

  /** 只返回版本/探测；数据库异常不转换成账号不存在或退出。 */
  @RestController
  public static final class FoundationController {
    private final Foundation foundation;
    private final Contracts contracts;
    private final String version;
    FoundationController(Foundation foundation, Contracts contracts) {
      this.foundation = foundation; this.contracts = contracts;
      Properties p = new Properties();
      try { p.load(new java.io.StringReader(contracts.resource("build.properties"))); }
      catch (IOException e) { throw new IllegalStateException("构建版本缺失", e); }
      version = Objects.requireNonNull(p.getProperty("productVersion"));
    }
    @GetMapping(value = "/api/v1/meta", produces = "application/json")
    public String meta() { return contracts.encode("MetaResponse", new PlatformDtos.MetaResponse(version, 1, "demo")); }
    @GetMapping(value = "/health", produces = "application/json")
    public ResponseEntity<String> health() {
      try { foundation.ping(); return ResponseEntity.ok(contracts.encode("HealthResponse", new PlatformDtos.HealthResponse("UP"))); }
      catch (DataAccessException e) { return ResponseEntity.status(503).body(contracts.encode("HealthResponse", new PlatformDtos.HealthResponse("DOWN"))); }
    }
  }

  /** 固定文案，不将底层异常/SQL/请求体带给客户端或日志。 */
  public static void failure(Contracts contracts, HttpServletRequest request, HttpServletResponse response, int status, String code) throws IOException {
    // MVC 异常退出可能清掉已选媒体类型；安全错误必须重新明确声明 JSON。
    response.setContentType("application/json"); response.setCharacterEncoding("UTF-8"); response.setHeader("Cache-Control", "no-store");
    if (code.equals("AUTHENTICATION_REQUIRED")) {
      var session = request.getSession(false);
      if (session != null) session.invalidate();
      SecurityContextHolder.clearContext();
    }
    String id = response.getHeader("X-Request-Id");
    if (id == null) id = UUID.randomUUID().toString();
    response.setStatus(status);
    String message = switch (code) {
      case "AUTHENTICATION_REQUIRED" -> "请先登录";
      case "DEMO_LOGIN_REJECTED" -> "演示账号不存在或已停用";
      case "CSRF_INVALID" -> "请求凭据已失效，请重试操作";
      case "RESOURCE_NOT_FOUND" -> "资源不可用";
      case "ALREADY_AUTHENTICATED" -> "请先退出当前账号";
      case "SERVICE_UNAVAILABLE" -> "服务连接暂不可用";
      case "REQUEST_SOURCE_REJECTED" -> "请求来源不允许";
      case "PROTOCOL_VERSION_UNSUPPORTED" -> "协议版本不支持";
      case "METHOD_NOT_ALLOWED" -> "请求方法不支持";
      case "UNSUPPORTED_MEDIA_TYPE" -> "请求正文必须使用 JSON";
      case "PAYLOAD_TOO_LARGE" -> "请求体过大";
      case "INVALID_REQUEST" -> "请求参数无效";
      default -> "服务暂时无法处理请求";
    };
    String body;
    try { body = contracts.encode("ErrorResponse", new PlatformDtos.ErrorResponse(new PlatformDtos.ErrorDetail(code, message, id, status == 503))); }
    catch (RuntimeException e) {
      response.setStatus(500);
      body = "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"服务暂时无法处理请求\",\"requestId\":\"" + id + "\",\"retryable\":false}}";
    }
    response.getWriter().write(body);
  }

  /** 在 CSRF 前限制路由、体积和请求形状，后续只消费已校验的 record。 */
  private static final class Boundary extends OncePerRequestFilter {
    private final Contracts contracts;
    private final String origin;
    private final String authority;
    Boundary(Contracts contracts, String origin, String authority) { this.contracts = contracts; this.origin = origin; this.authority = authority; }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
      String requestId = request.getHeader("X-Request-Id");
      if (requestId == null || !requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) requestId = UUID.randomUUID().toString();
      response.setHeader("X-Request-Id", requestId); response.setHeader("Cache-Control", "no-store"); response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
      try {
        String path = request.getRequestURI();
        if (!authority.equals(request.getHeader("Host")) || (!path.equals("/health") && !origin.equals(request.getHeader("Origin")))) throw new ApiProblem(403, "REQUEST_SOURCE_REJECTED");
        if (!path.equals("/health") && !"1".equals(request.getHeader("X-Workbench-Protocol-Version"))) throw new ApiProblem(426, "PROTOCOL_VERSION_UNSUPPORTED");
        if (request.getQueryString() != null) throw new ApiProblem(400, "INVALID_REQUEST");
        boolean post = path.equals("/api/v1/auth/demo-login") || path.equals("/api/v1/auth/logout");
        boolean memberPath = path.matches("/api/v1/workspaces/[^/]+/members");
        boolean get = Set.of("/health", "/api/v1/meta", "/api/v1/auth/csrf", "/api/v1/auth/demo-users", "/api/v1/auth/me", "/api/v1/workspaces").contains(path) || memberPath;
        if (!get && !post) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        if (!request.getMethod().equals(post ? "POST" : "GET")) throw new ApiProblem(405, "METHOD_NOT_ALLOWED");
        if (memberPath && !path.substring("/api/v1/workspaces/".length(), path.length() - "/members".length()).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new ApiProblem(400, "INVALID_REQUEST");
        if (request.getContentLengthLong() > 16384) throw new ApiProblem(413, "PAYLOAD_TOO_LARGE");
        byte[] bytes = request.getInputStream().readNBytes(16385);
        if (bytes.length > 16384) throw new ApiProblem(413, "PAYLOAD_TOO_LARGE");
        if (path.equals("/api/v1/auth/demo-login")) {
          if (request.getContentType() == null || !request.getContentType().split(";", 2)[0].trim().equalsIgnoreCase("application/json")) throw new ApiProblem(415, "UNSUPPORTED_MEDIA_TYPE");
          try { request.setAttribute("workbench.login", contracts.decode("DemoLoginRequest", new String(bytes, StandardCharsets.UTF_8), PlatformDtos.DemoLoginRequest.class)); }
          catch (RuntimeException e) { throw new ApiProblem(400, "INVALID_REQUEST"); }
        } else if (bytes.length != 0) throw new ApiProblem(400, "INVALID_REQUEST");
        chain.doFilter(request, response);
      } catch (Exception e) {
        if (response.isCommitted()) throw e;
        response.resetBuffer();
        Throwable cause = e;
        while (cause.getCause() != null && !(cause instanceof ApiProblem) && !(cause instanceof DataAccessException) && !(cause instanceof CannotCreateTransactionException)) cause = cause.getCause();
        if (cause instanceof ApiProblem p) failure(contracts, request, response, p.status, p.code);
        // 断库也可能发生在只读事务取连接时，尚未进入 JdbcTemplate 查询。
        else if (cause instanceof DataAccessException || cause instanceof CannotCreateTransactionException) failure(contracts, request, response, 503, "SERVICE_UNAVAILABLE");
        else failure(contracts, request, response, 500, "INTERNAL_ERROR");
      }
    }
  }
}
