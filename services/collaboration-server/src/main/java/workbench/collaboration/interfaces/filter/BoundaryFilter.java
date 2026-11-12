package workbench.collaboration.interfaces.filter;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.filter.OncePerRequestFilter;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.PlatformDtos;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.RouteCatalog;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * 模块：入站边界安全与参数校验过滤器 (BoundaryFilter)
 *
 * <p>【功能定义】
 * 作为所有 HTTP 请求到达控制器或 Spring Security 认证前的第一道防线。
 *
 * <p>【安全底线与前置校验流水线 (Invariants)】
 * <pre>
 * HTTP 请求 ──> 提取/生成 X-Request-Id (MDC 注入)
 *                  │
 *                  ▼
 *        [路由与白名单校验]
 *        ├── 路径不在 RouteCatalog 目录 ──> 404 RESOURCE_NOT_FOUND
 *        ├── 请求方法不受支持          ──> 405 METHOD_NOT_ALLOWED
 *        ├── Host 与 Origin 伪造校验   ──> 403 REQUEST_SOURCE_REJECTED
 *        ├── 协议版本不为 1            ──> 426 PROTOCOL_VERSION_UNSUPPORTED
 *        └── 路径 UUID 参数格式校验    ──> 400 INVALID_REQUEST
 *                  │
 *                  ▼
 *        [载荷与流控防御]
 *        ├── Query 参数正则白名单过滤   ──> 400 INVALID_REQUEST
 *        ├── 请求体超出允许最大字节数   ──> 413 PAYLOAD_TOO_LARGE
 *        └── Content-Type 必须为 JSON   ──> 415 UNSUPPORTED_MEDIA_TYPE
 *                  │
 *                  ▼
 *        封装 CachedBodyRequest ──> 保证后续过滤器与 Controller 可反复读取同一份原始字节流
 * </pre>
 *
 * <p>【协作边界】
 * - 上游调用方：Servlet 容器 Filter 链。
 * - 下游依赖方：RouteCatalog、Contracts、ApiResponses、CachedBodyRequest。
 */
public final class BoundaryFilter extends OncePerRequestFilter {

    private final Contracts contracts;
    private final RouteCatalog catalog;
    private final String origin;
    private final String authority;

    public BoundaryFilter(Contracts contracts, RouteCatalog catalog, String origin, String authority) {
        this.contracts = contracts;
        this.catalog = catalog;
        this.origin = origin;
        this.authority = authority;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String requestId = request.getHeader("X-Request-Id");
        if (requestId == null || !requestId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            requestId = UUID.randomUUID().toString();
        }
        MDC.put("requestId", requestId);
        response.setHeader("X-Request-Id", requestId);
        response.setHeader("Cache-Control", "no-store");

        try {
            String path = request.getRequestURI();
            RouteCatalog.Match match = catalog.match(path);
            if (match == null) {
                throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
            }

            RouteCatalog.Route route = match.route();
            String method = request.getMethod();
            if (!route.methods().contains(method)) {
                throw new ApiProblem(405, "METHOD_NOT_ALLOWED");
            }
            if (!authority.equals(request.getHeader("Host"))) {
                throw new ApiProblem(403, "REQUEST_SOURCE_REJECTED");
            }
            if (!path.equals("/health") && !origin.equals(request.getHeader("Origin"))) {
                throw new ApiProblem(403, "REQUEST_SOURCE_REJECTED");
            }
            if (!path.equals("/health") && !"1".equals(request.getHeader("X-Workbench-Protocol-Version"))) {
                throw new ApiProblem(426, "PROTOCOL_VERSION_UNSUPPORTED");
            }
            if (!match.hasValidPathIds()) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }

            validateQuery(request, route, method);

            int maxBody = method.equals("POST") ? route.maxBody() : 0;
            if (request.getContentLengthLong() > maxBody) {
                throw new ApiProblem(413, "PAYLOAD_TOO_LARGE");
            }
            byte[] bytes = request.getInputStream().readNBytes(maxBody + 1);
            if (bytes.length > maxBody) {
                throw new ApiProblem(413, "PAYLOAD_TOO_LARGE");
            }

            if (maxBody > 0) {
                String contentType = request.getContentType();
                if (contentType == null || !contentType.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) {
                    throw new ApiProblem(415, "UNSUPPORTED_MEDIA_TYPE");
                }
                if (bytes.length == 0) {
                    throw new ApiProblem(400, "INVALID_REQUEST");
                }
                if (path.equals("/api/v1/auth/demo-login")) {
                    try {
                        request.setAttribute(
                                "workbench.login",
                                contracts.decode("DemoLoginRequest", new String(bytes, StandardCharsets.UTF_8), PlatformDtos.DemoLoginRequest.class)
                        );
                    } catch (RuntimeException e) {
                        throw new ApiProblem(400, "INVALID_REQUEST");
                    }
                }
            }

            chain.doFilter(new CachedBodyRequest(request, bytes), response);
        } catch (Exception e) {
            if (response.isCommitted()) {
                throw e;
            }
            response.resetBuffer();
            Throwable cause = e;
            while (cause.getCause() != null && !(cause instanceof ApiProblem) && !(cause instanceof DataAccessException) && !(cause instanceof CannotCreateTransactionException)) {
                cause = cause.getCause();
            }
            if (cause instanceof ApiProblem problem) {
                ApiResponses.failure(contracts, request, response, problem.status, problem.code);
            } else if (cause instanceof DataAccessException || cause instanceof CannotCreateTransactionException) {
                ApiResponses.failure(contracts, request, response, 503, "SERVICE_UNAVAILABLE");
            } else {
                ApiResponses.failure(contracts, request, response, 500, "INTERNAL_ERROR");
            }
        } finally {
            MDC.remove("requestId");
        }
    }

    private static void validateQuery(HttpServletRequest request, RouteCatalog.Route route, String method) {
        String query = request.getQueryString();
        if (query == null) {
            return;
        }
        if (!method.equals("GET") || route.query().isEmpty()) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        if (query.isEmpty()) {
            return;
        }
        Set<String> names = new HashSet<>();
        for (String pair : query.split("&", -1)) {
            String[] parts = pair.split("=", 2);
            String key = decode(parts[0]);
            String value = parts.length == 2 ? decode(parts[1]) : "";
            var rule = route.query().get(key);
            if (!names.add(key) || rule == null || !rule.matcher(value).matches()) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
        }
    }

    private static String decode(String value) {
        try {
            return java.net.URLDecoder.decode(value, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
    }

    /**
     * 请求体缓存包装类，允许多次从流中读取请求正文字节。
     */
    private static final class CachedBodyRequest extends HttpServletRequestWrapper {
        private final byte[] body;

        private CachedBodyRequest(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream stream = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public int read() {
                    return stream.read();
                }

                @Override
                public int read(byte[] target, int offset, int length) {
                    return stream.read(target, offset, length);
                }

                @Override
                public boolean isFinished() {
                    return stream.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {}
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }
}
