package workbench.collaboration.infrastructure.config;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.web.servlet.ServletContextInitializer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.AbstractAuthenticationProcessingFilter;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.authentication.session.ChangeSessionIdAuthenticationStrategy;
import org.springframework.security.web.authentication.session.CompositeSessionAuthenticationStrategy;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextHolderFilter;
import org.springframework.security.web.csrf.CsrfAuthenticationStrategy;
import org.springframework.security.web.csrf.CsrfException;
import org.springframework.security.web.csrf.HttpSessionCsrfTokenRepository;
import org.springframework.security.web.util.matcher.RequestMatcher;
import workbench.collaboration.application.service.IdentityAppService;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.PlatformDtos;
import workbench.collaboration.interfaces.filter.BoundaryFilter;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.RouteCatalog;

import java.net.URI;
import java.util.List;

/**
 * 模块：Web 安全与多通道认证配置 (WebSecurityConfig)
 *
 * <p>【功能定义】
 * 配置基于 Spring Security 的 HTTP 核心安全过滤链。
 * 针对“人类用户浏览器会话”与“本机设备凭据自动化通信”实行通道隔离：
 * - 人类用户（SESSION 认证）：受 Cookie 会话持久化、登录切换 SessionId、跨站请求伪造 (CSRF) 防护；
 * - 本机设备（DEVICE 认证）：走 Bearer Token 签名凭证，免除 CSRF 检查但受到严格的报文指纹与边界校验；
 * - 一次性命令模式：通过 @ConditionalOnWebApplication 约束，命令行模式下完全不拉起 Web 安全链，极速执行。
 *
 * <p>【安全设计原则 (Why)】
 * 1. 登录会话重置（ChangeSessionIdAuthenticationStrategy）：登录成功后必须强制轮换 SessionId，杜绝会话固定攻击；
 * 2. CSRF 令牌刷新（CsrfAuthenticationStrategy）：登录后前置 CSRF 立即失效，防跨站利用；
 * 3. 拒绝双重认证（ALREADY_AUTHENTICATED）：已登录会话再次尝试调用登录接口直接阻断（409），防止会话污染。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring Boot WebMVC 容器。
 * - 下游依赖方：BoundaryFilter、DemoLoginFilter、IdentityAppService、Contracts、RouteCatalog。
 */
@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class WebSecurityConfig {

    @Bean
    UserDetailsService noDefaultUsers() {
        return new InMemoryUserDetailsManager();
    }

    @Bean
    RouteCatalog routeCatalog() {
        return new RouteCatalog();
    }

    @Bean
    ServletContextInitializer sessionCookieSecurity(WorkbenchProperties properties) {
        boolean secure = properties.getOrigin().startsWith("https://");
        return context -> context.getSessionCookieConfig().setSecure(secure);
    }

    @Bean
    SecurityFilterChain security(
            HttpSecurity http,
            Contracts contracts,
            IdentityAppService identity,
            RouteCatalog catalog,
            WorkbenchProperties properties
    ) throws Exception {
        String origin = properties.getOrigin();
        URI uri = URI.create(origin);
        // 校验 Origin 合法性：支持 http 与 https 源（适应企业内网与测试部署），禁止携带凭据、路径或参数
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty())
                || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
            throw new IllegalArgumentException("服务 origin 无效");
        }

        var contexts = new HttpSessionSecurityContextRepository();
        var csrf = new HttpSessionCsrfTokenRepository();

        DemoLoginFilter login = new DemoLoginFilter(identity, contracts);
        login.setSecurityContextRepository(contexts);
        login.setSessionAuthenticationStrategy(new CompositeSessionAuthenticationStrategy(List.of(
                new ChangeSessionIdAuthenticationStrategy(),
                new CsrfAuthenticationStrategy(csrf)
        )));

        // 识别属于设备专属的端点路由（免除浏览器 CSRF 检查）
        RequestMatcher deviceRoute = request -> {
            var match = catalog.match(request.getRequestURI());
            return match != null && match.route().auth() == RouteCatalog.Auth.DEVICE;
        };

        return http.securityContext(c -> c.securityContextRepository(contexts))
                .requestCache(AbstractHttpConfigurer::disable)
                .anonymous(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .csrf(c -> c.csrfTokenRepository(csrf).ignoringRequestMatchers(deviceRoute))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(
                                "/health",
                                "/api/v1/meta",
                                "/api/v1/auth/csrf",
                                "/api/v1/auth/demo-users",
                                "/api/v1/auth/demo-login",
                                "/api/v1/auth/logout"
                        ).permitAll()
                        .requestMatchers(deviceRoute).permitAll()
                        .anyRequest().authenticated()
                )
                .exceptionHandling(handler -> handler
                        .authenticationEntryPoint((request, response, error) ->
                                ApiResponses.failure(contracts, request, response, 401, "AUTHENTICATION_REQUIRED")
                        )
                        .accessDeniedHandler((request, response, error) ->
                                ApiResponses.failure(contracts, request, response, 403, csrfFailure(error) ? "CSRF_INVALID" : "REQUEST_SOURCE_REJECTED")
                        )
                )
                .logout(logout -> logout
                        .logoutRequestMatcher(request -> "POST".equals(request.getMethod()) && "/api/v1/auth/logout".equals(request.getRequestURI()))
                        .deleteCookies("WBSESSION")
                        .logoutSuccessHandler((request, response, auth) -> ApiResponses.success(response, "null"))
                )
                .addFilterBefore(new BoundaryFilter(contracts, catalog, origin, uri.getRawAuthority()), SecurityContextHolderFilter.class)
                .addFilterBefore(login, UsernamePasswordAuthenticationFilter.class)
                .build();
    }

    private static boolean csrfFailure(Exception error) {
        Throwable cause = error;
        while (cause != null) {
            if (cause instanceof CsrfException) {
                return true;
            }
            cause = cause.getCause();
        }
        return false;
    }

    /**
     * 演示账号快捷登录拦截器。
     *
     * <p>【安全不变量 (Invariants)】
     * 若当前上下文已处于认证状态，绝不接受二次登录请求，防止已有会话被冒名篡改覆盖。
     */
    static final class DemoLoginFilter extends AbstractAuthenticationProcessingFilter {
        private final IdentityAppService identity;
        private final Contracts contracts;

        DemoLoginFilter(IdentityAppService identity, Contracts contracts) {
            super(request -> "POST".equals(request.getMethod()) && "/api/v1/auth/demo-login".equals(request.getRequestURI()));
            this.identity = identity;
            this.contracts = contracts;
            setAuthenticationSuccessHandler(this::signedIn);
        }

        @Override
        public Authentication attemptAuthentication(HttpServletRequest request, HttpServletResponse response) {
            Authentication existing = SecurityContextHolder.getContext().getAuthentication();
            if (existing != null && existing.isAuthenticated() && !(existing instanceof AnonymousAuthenticationToken)) {
                throw new ApiProblem(409, "ALREADY_AUTHENTICATED");
            }
            PlatformDtos.DemoLoginRequest input = (PlatformDtos.DemoLoginRequest) request.getAttribute("workbench.login");
            if (input == null) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            String userId = identity.authenticate(input.username());
            return org.springframework.security.authentication.UsernamePasswordAuthenticationToken.authenticated(userId, null, List.of());
        }

        private void signedIn(HttpServletRequest request, HttpServletResponse response, Authentication auth) throws java.io.IOException {
            ApiResponses.success(response, contracts.encode("CurrentUserResponse", identity.current(auth.getName())));
        }
    }
}
