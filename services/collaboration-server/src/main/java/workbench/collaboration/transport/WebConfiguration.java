package workbench.collaboration.transport;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import workbench.collaboration.*;
import workbench.collaboration.conversation.*;
import workbench.collaboration.device.*;
import workbench.collaboration.execution.*;
import workbench.collaboration.identity.IdentityService;
import workbench.collaboration.identity.WorkspaceAccess;
import workbench.collaboration.infrastructure.Foundation;
import workbench.collaboration.realtime.*;
import workbench.collaboration.project.*;
import javax.sql.DataSource;
import org.springframework.context.annotation.*;
import org.springframework.core.env.Environment;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.*;
import org.springframework.security.web.context.*;
import org.springframework.security.web.authentication.*;
import org.springframework.security.web.authentication.session.*;
import org.springframework.security.web.csrf.*;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 身份/会话/设备 HTTP 装配：来源/形状 → CSRF → Spring 认证与会话 → 启用状态/成员 → 安全 DTO。
 * 路由只来自有限 RouteCatalog；设备 Bearer 与浏览器 Cookie 严格分流。
 */
@Configuration(proxyBeanMethods = false)
@Import({IdentityController.class, ConversationController.class, DeviceController.class,
  ConversationStreamController.class, ProjectReadController.class, ApiExceptionHandler.class, DeviceWebSocketConfiguration.class})
public class WebConfiguration {
  @Bean UserDetailsService noDefaultUsers() { return new InMemoryUserDetailsManager(); }
  @Bean WorkspaceAccess workspaceAccess(DataSource source) { return new WorkspaceAccess(source); }
  @Bean IdentityService identityService(DataSource source) { return new IdentityService(source); }
  @Bean RouteCatalog routeCatalog() { return new RouteCatalog(); }
  @Bean ExecutionCodec executionCodec() { return new ExecutionCodec(); }
  @Bean DevicePresence devicePresence() { return new DevicePresence(); }
  @Bean DeviceService deviceService(DataSource source, Contracts contracts, WorkspaceAccess access, DevicePresence presence) {
    return new DeviceService(source, contracts, access, presence);
  }
  @Bean ConversationStore conversationStore(DataSource source) { return new ConversationStore(source); }
  @Bean ConversationService conversationService(DataSource source, Contracts contracts, WorkspaceAccess access,
                                                DeviceService devices, ConversationStore store) {
    return new ConversationService(source, contracts, access, devices, store);
  }
  @Bean ExecutionReceiptsService executionReceiptsService(DataSource source, Contracts contracts, ExecutionCodec codec,
                                                          ConversationStore store, ConversationService conversations) {
    return new ExecutionReceiptsService(source, contracts, codec, store, conversations);
  }
  @Bean ExecutionRecoveryService executionRecoveryService(DataSource source, ConversationStore store, ExecutionCodec codec) {
    return new ExecutionRecoveryService(source, store, codec);
  }
  @Bean DeviceChannel deviceChannel(Contracts contracts, DeviceService devices, DevicePresence presence,
                                    ConversationStore store, ConversationService conversations,
                                    ExecutionReceiptsService receipts, ExecutionRecoveryService recovery, ExecutionCodec codec) {
    return new DeviceChannel(contracts, devices, presence, store, conversations, receipts, recovery, codec);
  }
  @Bean DeviceHandshakeInterceptor deviceHandshakeInterceptor(DeviceService devices) { return new DeviceHandshakeInterceptor(devices); }
  @Bean ProjectReadAccess projectReadAccess(Environment environment) { return new DemoProjectReadAccess(environment); }
  @Bean ProjectReadService projectReadService(DataSource source, Contracts contracts, WorkspaceAccess access, ConversationStore store,
                                               DeviceService devices, DeviceChannel channel, ProjectReadAccess projectReadAccess) {
    return new ProjectReadService(source, contracts, access, store, devices, channel, projectReadAccess);
  }

  @Bean(initMethod = "start", destroyMethod = "stop")
  @DependsOn("foundation")
  ExecutionDispatcher executionDispatcher(DataSource source, ConversationStore store, ConversationService conversations,
                                          DeviceDelivery delivery, ExecutionCodec codec) {
    return new ExecutionDispatcher(source, store, conversations, delivery, codec);
  }
  @Bean ConversationStreamService conversationStreamService(DataSource source, ConversationStore store, WorkspaceAccess access, Contracts contracts) {
    return new ConversationStreamService(source, store, access, contracts);
  }

  @Bean ServletContextInitializer sessionCookieSecurity(Environment env) {
    boolean secure = env.getRequiredProperty("workbench.origin").startsWith("https://");
    return context -> context.getSessionCookieConfig().setSecure(secure);
  }

  @Bean SecurityFilterChain security(HttpSecurity http, Foundation foundation, Contracts contracts, IdentityService identity,
                                     RouteCatalog catalog, Environment env) throws Exception {
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
      response.setContentType(MediaType.APPLICATION_JSON_VALUE);
      response.setCharacterEncoding("UTF-8");
      response.getWriter().write(contracts.encode("CurrentUserResponse", identity.current(auth.getName())));
    });
    login.setAuthenticationFailureHandler((request, response, error) -> failure(contracts, request, response, 401, "DEMO_LOGIN_REJECTED"));
    RequestMatcher deviceRoute = request -> {
      var match = catalog.match(request.getRequestURI());
      return match != null && match.route().auth() == RouteCatalog.Auth.DEVICE;
    };
    return http.securityContext(c -> c.securityContextRepository(contexts))
      .requestCache(c -> c.disable())
      .csrf(c -> c.csrfTokenRepository(csrf).ignoringRequestMatchers(deviceRoute))
      .authorizeHttpRequests(a -> a.requestMatchers("/health", "/api/v1/meta", "/api/v1/auth/csrf", "/api/v1/auth/demo-users",
          "/api/v1/auth/demo-login", "/api/v1/auth/logout").permitAll()
        .requestMatchers(deviceRoute).permitAll().anyRequest().authenticated())
      .exceptionHandling(h -> h.authenticationEntryPoint((request, response, e) -> failure(contracts, request, response, 401, "AUTHENTICATION_REQUIRED"))
        .accessDeniedHandler((request, response, e) -> failure(contracts, request, response, 403, e instanceof CsrfException ? "CSRF_INVALID" : "REQUEST_SOURCE_REJECTED")))
      .logout(l -> l.logoutRequestMatcher(request -> request.getMethod().equals("POST") && request.getRequestURI().equals("/api/v1/auth/logout"))
        .deleteCookies("WBSESSION").logoutSuccessHandler((request, response, auth) -> response.setStatus(204)))
      .addFilterBefore(new Boundary(contracts, origin, uri.getRawAuthority(), catalog), SecurityContextHolderFilter.class)
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
      try { p.load(new StringReader(contracts.resource("build.properties"))); }
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
    response.setContentType("application/json"); response.setCharacterEncoding("UTF-8"); response.setHeader("Cache-Control", "no-store");
    if (code.equals("AUTHENTICATION_REQUIRED")) {
      var session = request.getSession(false);
      if (session != null) session.invalidate();
      SecurityContextHolder.clearContext();
    }
    String id = response.getHeader("X-Request-Id");
    if (id == null) {
      id = UUID.randomUUID().toString();
      response.setHeader("X-Request-Id", id);
    }
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
      case "DEVICE_AUTHENTICATION_REQUIRED" -> "设备凭据已失效";
      case "REQUEST_ID_CONFLICT" -> "请求编号已用于其他操作";
      case "CURSOR_AHEAD" -> "事件位置超出已提交范围";
      case "PROJECT_NOT_SHARED" -> "项目未共享或已停止共享";
      case "TARGET_UNAVAILABLE" -> "目标设备或执行配置不可用";
      case "EXECUTION_STATE_CONFLICT" -> "执行状态已变化，请刷新";
      case "REGISTRATION_CONFLICT" -> "设备标识已被占用";
      case "SHARE_VERSION_CONFLICT" -> "共享版本已变化，请刷新后重试";
      case "DEVICE_ACTION_REJECTED" -> "当前账号不能管理该设备";
      case "PROJECT_READ_UNAVAILABLE" -> "设备尚未接入项目读取";
      case "PROJECT_READ_BUSY", "PROJECT_BUSY" -> "项目读取繁忙，请稍后重试";
      case "PROJECT_READ_TIMEOUT" -> "项目读取超时";
      case "PROJECT_SOURCE_UNKNOWN" -> "项目来源尚未确认";
      case "PROJECT_REPOSITORY_DENIED" -> "当前账号没有仓库读取权限";
      case "PROJECT_IDENTITY_UNBOUND" -> "当前账号尚未绑定 Git 身份";
      case "PROJECT_AUTH_UNAVAILABLE" -> "仓库权限暂时无法核验";
      case "PROJECT_ROOT_CHANGED" -> "原设备项目目录已变化";
      case "PROJECT_PATH_INVALID" -> "项目路径无效";
      case "PROJECT_FILE_NOT_FOUND" -> "项目文件不存在";
      case "PROJECT_FILE_DENIED" -> "原设备没有文件读取权限";
      case "PROJECT_FILE_UNSUPPORTED" -> "项目文件暂不支持预览";
      case "PROJECT_FILE_CHANGED" -> "项目文件已变化，请刷新";
      case "PROJECT_CURSOR_EXPIRED" -> "目录已变化，请重新加载";
      case "PROJECT_LIMIT_EXCEEDED" -> "项目内容超出读取限制";
      case "PROJECT_GIT_UNAVAILABLE" -> "Git 状态暂不可用";
      case "PROJECT_GIT_ROOT_REQUIRED" -> "请登记完整仓库根目录";
      case "PROJECT_GIT_STALE" -> "Git 状态已变化，请刷新";
      case "PROJECT_READ_FAILED" -> "项目读取失败";
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

  /** 在 CSRF 前限制路由、体积和查询形状，后续只消费已校验的请求。 */
  private static final class Boundary extends OncePerRequestFilter {
    private final Contracts contracts;
    private final String origin;
    private final String authority;
    private final RouteCatalog catalog;
    Boundary(Contracts contracts, String origin, String authority, RouteCatalog catalog) {
      this.contracts = contracts; this.origin = origin; this.authority = authority; this.catalog = catalog;
    }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
      request.setAttribute("workbench.requestStarted", System.nanoTime());
      String requestId = request.getHeader("X-Request-Id");
      if (requestId == null || !requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) requestId = UUID.randomUUID().toString();
      response.setHeader("X-Request-Id", requestId); response.setHeader("Cache-Control", "no-store");
      response.setContentType("application/json"); response.setCharacterEncoding("UTF-8");
      try {
        String path = request.getRequestURI();
        RouteCatalog.Match match = catalog.match(path);
        if (match == null) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        RouteCatalog.Route route = match.route();
        String method = request.getMethod();
        if (!route.methods().contains(method)) throw new ApiProblem(405, "METHOD_NOT_ALLOWED");
        if (!authority.equals(request.getHeader("Host"))) throw new ApiProblem(403, "REQUEST_SOURCE_REJECTED");
        if (!path.equals("/health") && !origin.equals(request.getHeader("Origin"))) throw new ApiProblem(403, "REQUEST_SOURCE_REJECTED");
        if (!path.equals("/health") && !"1".equals(request.getHeader("X-Workbench-Protocol-Version"))) throw new ApiProblem(426, "PROTOCOL_VERSION_UNSUPPORTED");
        if (!match.hasValidPathIds()) throw new ApiProblem(400, "INVALID_REQUEST");
        validateQuery(request, route, method);
        // 同一路径上的 GET 读取列表、POST 才写入；列表不需要 JSON 正文。
        int maxBody = method.equals("POST") ? route.maxBody() : 0;
        if (request.getContentLengthLong() > maxBody) throw new ApiProblem(413, "PAYLOAD_TOO_LARGE");
        byte[] bytes = request.getInputStream().readNBytes(maxBody + 1);
        if (bytes.length > maxBody) throw new ApiProblem(413, "PAYLOAD_TOO_LARGE");
        if (maxBody > 0) {
          if (request.getContentType() == null || !request.getContentType().split(";", 2)[0].trim().equalsIgnoreCase("application/json"))
            throw new ApiProblem(415, "UNSUPPORTED_MEDIA_TYPE");
          if (bytes.length == 0) throw new ApiProblem(400, "INVALID_REQUEST");
          if (path.equals("/api/v1/auth/demo-login")) {
            try { request.setAttribute("workbench.login", contracts.decode("DemoLoginRequest", new String(bytes, StandardCharsets.UTF_8), PlatformDtos.DemoLoginRequest.class)); }
            catch (RuntimeException e) { throw new ApiProblem(400, "INVALID_REQUEST"); }
          }
        }
        chain.doFilter(new CachedBodyRequest(request, bytes), response);
      } catch (Exception e) {
        if (response.isCommitted()) throw e;
        response.resetBuffer();
        Throwable cause = e;
        while (cause.getCause() != null && !(cause instanceof ApiProblem) && !(cause instanceof DataAccessException) && !(cause instanceof CannotCreateTransactionException)) cause = cause.getCause();
        if (cause instanceof ApiProblem p) failure(contracts, request, response, p.status, p.code);
        else if (cause instanceof DataAccessException || cause instanceof CannotCreateTransactionException) failure(contracts, request, response, 503, "SERVICE_UNAVAILABLE");
        else failure(contracts, request, response, 500, "INTERNAL_ERROR");
      }
    }

    private void validateQuery(HttpServletRequest request, RouteCatalog.Route route, String method) {
      String query = request.getQueryString();
      if (query == null) return;
      if (!method.equals("GET") || route.query().isEmpty()) throw new ApiProblem(400, "INVALID_REQUEST");
      if (query.isEmpty()) return;
      Set<String> names = new HashSet<>();
      for (String pair : query.split("&", -1)) {
        String[] parts = pair.split("=", 2);
        String key = decode(parts[0]);
        String value = parts.length == 2 ? decode(parts[1]) : "";
        var rule = route.query().get(key);
        if (!names.add(key) || rule == null || !rule.matcher(value).matches()) throw new ApiProblem(400, "INVALID_REQUEST");
      }
    }

    private static String decode(String value) {
      try { return java.net.URLDecoder.decode(value, StandardCharsets.UTF_8); }
      catch (IllegalArgumentException e) { throw new ApiProblem(400, "INVALID_REQUEST"); }
    }
  }

  /** 已校验正文缓存：控制器仍可通过 @RequestBody 读取同一字节。 */
  private static final class CachedBodyRequest extends HttpServletRequestWrapper {
    private final byte[] body;
    CachedBodyRequest(HttpServletRequest request, byte[] body) { super(request); this.body = body; }
    @Override public ServletInputStream getInputStream() {
      ByteArrayInputStream stream = new ByteArrayInputStream(body);
      return new ServletInputStream() {
        @Override public int read() { return stream.read(); }
        @Override public int read(byte[] target, int offset, int length) { return stream.read(target, offset, length); }
        @Override public boolean isFinished() { return stream.available() == 0; }
        @Override public boolean isReady() { return true; }
        @Override public void setReadListener(ReadListener listener) { }
      };
    }
    @Override public BufferedReader getReader() { return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8)); }
    @Override public int getContentLength() { return body.length; }
    @Override public long getContentLengthLong() { return body.length; }
  }
}
