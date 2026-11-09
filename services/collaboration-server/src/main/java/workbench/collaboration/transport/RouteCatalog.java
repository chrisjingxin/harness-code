package workbench.collaboration.transport;

import java.util.*;
import java.util.regex.Pattern;

/**
 * 有限业务路由目录：路径模板、方法、auth 类别、查询白名单和正文上限集中在一处。
 * 路由不存在即 404；不允许任意 query/debug 参数进入生产。
 */
public final class RouteCatalog {
  public enum Auth { PUBLIC, USER, DEVICE }
  public record Route(String pattern, Set<String> methods, Auth auth, int maxBody, Map<String, Pattern> query) {}
  public record Match(Route route, Map<String, String> path) {
    /** 已知路由的非法 ID 属于参数错误，和未知路由分开返回。 */
    public boolean hasValidPathIds() { return path.values().stream().allMatch(ID.asMatchPredicate()); }
  }

  private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
  private static final Pattern SEQUENCE = Pattern.compile("(?:0|[1-9][0-9]{0,18})");
  private static final Pattern TIME = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z");
  private static final Pattern LIMIT = Pattern.compile("[1-9][0-9]{0,2}");
  private static final Pattern OPERATION = Pattern.compile("conversation\\.create|input\\.send|execution\\.cancel");
  private static final Map<String, Pattern> NONE = Map.of();
  private static final Map<String, Pattern> PAGE = Map.of("limit", LIMIT, "beforeCreatedAt", TIME, "beforeId", ID);
  private static final Map<String, Pattern> DEVICE_PAGE = Map.of("limit", LIMIT, "beforeCreatedAt", TIME, "beforeDeviceId", ID);
  private static final Map<String, Pattern> PROJECT_PAGE = Map.of("limit", LIMIT, "beforeCreatedAt", TIME, "beforeProjectId", ID);

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
    new Route("/api/v1/workspaces/{workspaceId}/conversations", Set.of("GET", "POST"), Auth.USER, 16384, PAGE),
    new Route("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}", Set.of("GET"), Auth.USER, 0, NONE),
    new Route("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/inputs", Set.of("POST"), Auth.USER, 65536, NONE),
    new Route("/api/v1/workspaces/{workspaceId}/requests/{requestId}", Set.of("GET"), Auth.USER, 0, Map.of("operation", OPERATION)),
    new Route("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/executions/{executionId}", Set.of("GET"), Auth.USER, 0, NONE),
    new Route("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/executions/{executionId}/cancel", Set.of("POST"), Auth.USER, 16384, NONE),
    new Route("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/history", Set.of("GET"), Auth.USER, 0,
      Map.of("afterSequence", SEQUENCE, "throughSequence", SEQUENCE, "limit", LIMIT)),
    new Route("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/events", Set.of("GET"), Auth.USER, 0,
      Map.of("afterSequence", SEQUENCE)),
    new Route("/api/v1/workspaces/{workspaceId}/devices", Set.of("GET", "POST"), Auth.USER, 16384, DEVICE_PAGE),
    new Route("/api/v1/workspaces/{workspaceId}/devices/{deviceId}/projects", Set.of("GET"), Auth.USER, 0, PROJECT_PAGE),
    new Route("/api/v1/workspaces/{workspaceId}/devices/{deviceId}/revoke", Set.of("POST"), Auth.USER, 16384, NONE),
    new Route("/api/v1/workspaces/{workspaceId}/projects/{projectId}/stop-sharing", Set.of("POST"), Auth.USER, 16384, NONE),
    new Route("/api/v1/device/projects", Set.of("POST"), Auth.DEVICE, 16384, NONE),
    new Route("/api/v1/device/channel", Set.of("GET"), Auth.DEVICE, 0, NONE)
  );

  public RouteCatalog() {
    Set<String> patterns = new HashSet<>();
    for (Route route : routes) if (!patterns.add(route.pattern())) throw new IllegalStateException("路由重复登记");
  }

  /** 先匹配路径模板，调用方再检查方法和 ID。 */
  public Match match(String path) {
    for (Route route : routes) {
      Map<String, String> variables = matchPattern(route.pattern(), path);
      if (variables != null) return new Match(route, variables);
    }
    return null;
  }

  private static Map<String, String> matchPattern(String pattern, String path) {
    String[] expected = pattern.split("/", -1);
    String[] actual = path.split("/", -1);
    if (expected.length != actual.length) return null;
    Map<String, String> variables = new HashMap<>();
    for (int index = 0; index < expected.length; index++) {
      String segment = expected[index];
      if (segment.startsWith("{") && segment.endsWith("}")) {
        if (actual[index].isEmpty()) return null;
        variables.put(segment.substring(1, segment.length() - 1), actual[index]);
      } else if (!segment.equals(actual[index])) return null;
    }
    return variables;
  }
}
