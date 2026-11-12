package workbench.collaboration.interfaces.http;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 模块：受保护 HTTP 路由目录与匹配引擎 (RouteCatalog)
 *
 * <p>【功能定义】
 * 统一定义协作服务对外开放的所有合法 HTTP 路由白名单清单。
 * 针对每个端点精确绑定其支持的 HTTP Methods、认证主体要求（PUBLIC 公开、USER 用户会话、DEVICE 设备凭据）、
 * 最大允许请求体字节上限（maxBody）以及 URL Query 参数严格正则校验规则。
 * 遵循严格白名单原则：未在此目录声明的路径一律视为 404；已知路径上的未知或非法格式参数一律视为 400。
 *
 * <p>【HC-211 边界变化】
 * 远程输入、执行登记/取消、会话级 SSE、设备共享项目与 Daemon WSS 下行通道已全部拆除；
 * 项目组织面（项目/成员/仓库目录/引用）、设备本机仓库登记、项目内会话只读共享
 * （登记/简报/历史）与设备上传通道（sync/heartbeat）已登记。
 *
 * <p>【协作边界】
 * - 上游调用方：BoundaryFilter、WebSecurityConfig。
 * - 下游依赖方：无外部依赖。
 */
public final class RouteCatalog {

    /** 认证主体类型要求 */
    public enum Auth { PUBLIC, USER, DEVICE }

    /** 单个路由规格定义 */
    public record Route(String pattern, Set<String> methods, Auth auth, int maxBody, Map<String, Pattern> query) {}

    /** 路由匹配命中结果 */
    public record Match(Route route, Map<String, String> path) {
        /** 强校验路径中捕获的所有业务标识变量是否均符合标准 UUID 正则 */
        public boolean hasValidPathIds() {
            return path.values().stream().allMatch(ID.asMatchPredicate());
        }
    }

    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern TIME = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z");
    private static final Pattern LIMIT = Pattern.compile("[1-9][0-9]{0,2}");
    private static final Pattern SEQUENCE = Pattern.compile("[0-9]{1,19}");
    private static final Map<String, Pattern> NONE = Map.of();
    private static final Map<String, Pattern> DEVICE_PAGE = Map.of("limit", LIMIT, "beforeCreatedAt", TIME, "beforeDeviceId", ID);
    private static final Map<String, Pattern> REPOSITORY_PAGE = Map.of("status", Pattern.compile("active|archived"));
    private static final Map<String, Pattern> CONVERSATION_PAGE = Map.of("ownerId", ID, "status", Pattern.compile("idle|running|waiting_approval|error"));
    private static final Map<String, Pattern> HISTORY_PAGE = Map.of("afterSequence", SEQUENCE, "limit", Pattern.compile("[1-9][0-9]{0,2}"));

    private final List<Route> routes = List.of(
            new Route("/health", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/meta", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/csrf", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/demo-users", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/demo-login", Set.of("POST"), Auth.PUBLIC, 16384, NONE),
            new Route("/api/v1/auth/logout", Set.of("POST"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/me", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/members", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/devices", Set.of("GET", "POST"), Auth.USER, 16384, DEVICE_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/devices/{deviceId}/revoke", Set.of("POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects", Set.of("GET", "POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}", Set.of("GET", "PATCH"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members", Set.of("GET", "POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members/{userId}", Set.of("DELETE"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories/{repositoryId}", Set.of("PUT", "DELETE"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/repositories", Set.of("GET", "POST"), Auth.USER, 16384, REPOSITORY_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/repositories/{repositoryId}", Set.of("GET", "PATCH"), Auth.USER, 16384, NONE),
            new Route("/api/v1/device/repo-bindings/{repositoryId}", Set.of("PUT", "DELETE"), Auth.DEVICE, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations", Set.of("GET", "POST"), Auth.USER, 16384, CONVERSATION_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/history", Set.of("GET"), Auth.USER, 0, HISTORY_PAGE),
            new Route("/api/v1/device/conversations/{conversationId}/sync", Set.of("POST"), Auth.DEVICE, 1048576, NONE),
            new Route("/api/v1/device/heartbeat", Set.of("POST"), Auth.DEVICE, 0, NONE)
    );

    public RouteCatalog() {
        Set<String> patterns = new HashSet<>();
        for (Route route : routes) {
            if (!patterns.add(route.pattern())) {
                throw new IllegalStateException("路由重复登记: " + route.pattern());
            }
        }
    }

    /**
     * 匹配请求 URL 路径并提取路径参数字典。
     *
     * @param path 请求 URI
     * @return 匹配成功返回 Match 结果，未注册路径返回 null
     */
    public Match match(String path) {
        for (Route route : routes) {
            Map<String, String> variables = matchPattern(route.pattern(), path);
            if (variables != null) {
                return new Match(route, variables);
            }
        }
        return null;
    }

    private static Map<String, String> matchPattern(String pattern, String path) {
        String[] expected = pattern.split("/", -1);
        String[] actual = path.split("/", -1);
        if (expected.length != actual.length) {
            return null;
        }
        Map<String, String> variables = new HashMap<>();
        for (int index = 0; index < expected.length; index++) {
            String segment = expected[index];
            if (segment.startsWith("{") && segment.endsWith("}")) {
                if (actual[index].isEmpty()) {
                    return null;
                }
                variables.put(segment.substring(1, segment.length() - 1), actual[index]);
            } else if (!segment.equals(actual[index])) {
                return null;
            }
        }
        return variables;
    }
}
