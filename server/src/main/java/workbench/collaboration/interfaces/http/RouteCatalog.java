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
 * 针对每个端点精确绑定其支持的 HTTP Methods、认证主体要求（PUBLIC 公开、USER 用户会话）、
 * 最大允许请求体字节上限（maxBody）以及 URL Query 参数严格正则校验规则。
 * 遵循严格白名单原则：未在此目录声明的路径一律视为 404；已知路径上的未知或非法格式参数一律视为 400。
 *
 * <p>【协作边界】
 * - 上游调用方：BoundaryFilter、WebSecurityConfig。
 * - 下游依赖方：无外部依赖。
 */
public final class RouteCatalog {

    /** 认证主体类型要求 */
    public enum Auth { PUBLIC, USER }

    /** 单个路由规格定义 */
    public record Route(String pattern, Set<String> methods, Auth auth, int maxBody, Map<String, Pattern> query) {}

    /** 路由匹配命中结果 */
    public record Match(Route route, Map<String, String> path) {
        /** 强校验路径中捕获的业务标识变量：userId 为 32 位无横杠 UUID，其余实体标识为标准 UUID */
        public boolean hasValidPathIds() {
            return path.entrySet().stream().allMatch(entry ->
                ("userId".equals(entry.getKey()) ? USER_ID : ID).asMatchPredicate().test(entry.getValue()));
        }
    }

    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern USER_ID = Pattern.compile("[0-9a-f]{32}");
    private static final Pattern LIMIT = Pattern.compile("[1-9][0-9]{0,2}");
    private static final Pattern SEQUENCE = Pattern.compile("[0-9]{1,19}");
    private static final Map<String, Pattern> NONE = Map.of();
    private static final Map<String, Pattern> REPOSITORY_PAGE = Map.of("status", Pattern.compile("active|archived"));
    private static final Map<String, Pattern> CONVERSATION_PAGE = Map.of("ownerId", USER_ID, "status", Pattern.compile("idle|running|waiting_approval|error"));
    private static final Map<String, Pattern> HISTORY_PAGE = Map.of("afterSequence", SEQUENCE, "limit", Pattern.compile("[1-9][0-9]{0,2}"));

    private static final Map<String, Pattern> ID_PAGE = Map.of("afterId", ID, "limit", LIMIT);
    private static final Map<String, Pattern> TASK_PAGE = Map.of("afterId", ID, "limit", LIMIT,
            "assignee", Pattern.compile("me"), "creator", Pattern.compile("me"),
            "status", Pattern.compile("todo|doing|review|done|cancelled"));
    private static final Map<String, Pattern> KNOWLEDGE_PAGE = Map.of("afterId", ID, "limit", LIMIT,
            "category", Pattern.compile(".{1,80}"), "q", Pattern.compile(".{1,200}"),
            "level", Pattern.compile("rule|experience|term"), "scopeMode", Pattern.compile("all|applicable"),
            "repositoryIds", Pattern.compile(ID.pattern()+"(,"+ID.pattern()+"){0,19}"));
    private static final Map<String, Pattern> PROPOSAL_PAGE=Map.of("view",Pattern.compile("mine|review"),"status",Pattern.compile("draft|submitted|returned|published|withdrawn"),"afterId",ID,"limit",LIMIT);
    private static final Map<String, Pattern> EVENT_PAGE=Map.of("afterId",SEQUENCE,"limit",LIMIT);
    private static final Map<String, Pattern> NOTIFICATION_PAGE = Map.of("afterId", SEQUENCE, "limit", LIMIT);
    private static final Map<String, Pattern> INBOX_PAGE = Map.of(
            "bucket", Pattern.compile("action_required|sent|resolved"),
            "category", Pattern.compile("[a-z][a-z0-9_]{0,63}"),
            "workspaceId", ID,
            "limit", LIMIT
    );

    private final List<Route> routes = List.of(
            new Route("/health", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/meta", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/csrf", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/demo-users", Set.of("GET"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/demo-login", Set.of("POST"), Auth.PUBLIC, 16384, NONE),
            new Route("/api/v1/auth/logout", Set.of("POST"), Auth.PUBLIC, 0, NONE),
            new Route("/api/v1/auth/me", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/members", Set.of("GET", "POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/access", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/members/{userId}/role", Set.of("PATCH"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/members/{userId}/removal-preview", Set.of("GET"), Auth.USER, 0,
                Map.of("afterId", Pattern.compile("^(project|task|repository):[0-9a-f-]{36}$"), "previewVersion", Pattern.compile("^[0-9a-f]{64}$"), "limit", LIMIT)),
            new Route("/api/v1/workspaces/{workspaceId}/members/{userId}/removal", Set.of("POST"), Auth.USER, 65536, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects", Set.of("GET", "POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}", Set.of("GET", "PATCH"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members", Set.of("GET", "POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members/{userId}", Set.of("DELETE"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories/{repositoryId}", Set.of("PUT", "DELETE"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/repositories", Set.of("GET", "POST"), Auth.USER, 16384, REPOSITORY_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/repositories/{repositoryId}", Set.of("GET", "PATCH"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations", Set.of("GET", "POST"), Auth.USER, 16384, CONVERSATION_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/history", Set.of("GET"), Auth.USER, 0, HISTORY_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/snapshots", Set.of("POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/snapshots/{snapshotId}", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks", Set.of("GET", "POST"), Auth.USER, 16384, TASK_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}", Set.of("GET", "PATCH"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/transitions", Set.of("POST"), Auth.USER, 16384, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/conversation", Set.of("PUT"), Auth.USER, 4096, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge", Set.of("GET", "POST"), Auth.USER, 131072, KNOWLEDGE_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge/{knowledgeId}", Set.of("GET", "PUT", "DELETE"), Auth.USER, 131072,
                    Map.of("expectedVersion", SEQUENCE, "requestId", ID)),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge/{knowledgeId}/versions", Set.of("GET"), Auth.USER, 0, ID_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge/{knowledgeId}/versions/{versionId}", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-proposals", Set.of("GET","POST"), Auth.USER, 131072, PROPOSAL_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-proposals/{proposalId}", Set.of("GET","PUT"), Auth.USER, 131072, EVENT_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-proposals/{proposalId}/events", Set.of("GET"), Auth.USER, 0, EVENT_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-proposals/{proposalId}/submit", Set.of("POST"), Auth.USER, 4096, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-proposals/{proposalId}/withdraw", Set.of("POST"), Auth.USER, 4096, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-proposals/{proposalId}/review", Set.of("POST"), Auth.USER, 131072, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge/{knowledgeId}/versions/{versionId}/reads", Set.of("POST"), Auth.USER, 4096, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge/{knowledgeId}/versions/{versionId}/feedback", Set.of("GET","PUT"), Auth.USER, 4096, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge-reviews", Set.of("GET"), Auth.USER, 0, ID_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/knowledge/{knowledgeId}/review", Set.of("GET","POST"), Auth.USER, 8192, EVENT_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/board", Set.of("GET"), Auth.USER, 0, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/notifications", Set.of("GET"), Auth.USER, 0, NOTIFICATION_PAGE),
            new Route("/api/v1/workspaces/{workspaceId}/notifications/stream", Set.of("GET"), Auth.USER, 0, Map.of("afterId", SEQUENCE)),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/sync", Set.of("POST"), Auth.USER, 1048576, NONE),
            new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/stop-sharing", Set.of("POST"), Auth.USER, 0, NONE),
            new Route("/api/v1/me/inbox", Set.of("GET"), Auth.USER, 0, INBOX_PAGE),
            new Route("/api/v1/me/notifications", Set.of("GET"), Auth.USER, 0, NOTIFICATION_PAGE),
            new Route("/api/v1/me/notifications/stream", Set.of("GET"), Auth.USER, 0, Map.of("afterId", SEQUENCE)),
            new Route("/api/v1/me/notification-preferences", Set.of("GET", "PUT"), Auth.USER, 4096, NONE)
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
