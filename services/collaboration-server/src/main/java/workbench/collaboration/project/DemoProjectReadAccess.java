package workbench.collaboration.project;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import org.springframework.core.env.Environment;
import workbench.collaboration.device.DeviceDtos.ReadableProject;

import java.util.Set;

/** 受信服务端演示配置只允许精确匹配一个已登记项目及其共享版本。 */
public final class DemoProjectReadAccess implements ProjectReadAccess {
  private record Binding(String workspaceId, String deviceId, String projectId, long shareVersion) {}
  private final Binding binding;

  public DemoProjectReadAccess(Environment environment) {
    String configured = environment.getProperty("WORKBENCH_PROJECT_READ_DEMO_LOCAL_BINDING");
    if (configured == null || configured.isBlank()) { binding = null; return; }
    try {
      JsonNode node = JsonMapper.builder().build().readTree(configured);
      if (!node.isObject() || !node.propertyNames().equals(Set.of("workspaceId", "deviceId", "projectId", "shareVersion")))
        throw new IllegalArgumentException();
      String workspace = value(node, "workspaceId"), device = value(node, "deviceId"), project = value(node, "projectId");
      String version = value(node, "shareVersion");
      String id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      if (!workspace.matches(id) || !device.matches(id) || !project.matches(id)
          || !version.matches("[1-9][0-9]{0,18}")) throw new IllegalArgumentException();
      binding = new Binding(workspace, device, project, Long.parseLong(version));
    } catch (RuntimeException invalid) {
      throw new IllegalArgumentException("演示项目来源绑定配置无效");
    }
  }

  private static String value(JsonNode node, String field) {
    JsonNode value = node.get(field);
    if (value == null || !value.isString()) throw new IllegalArgumentException();
    return value.asText();
  }

  @Override public Decision authorize(String currentUserId, ReadableProject project) {
    if (binding != null && binding.workspaceId().equals(project.workspaceId()) && binding.deviceId().equals(project.deviceId())
      && binding.projectId().equals(project.projectId()) && binding.shareVersion() == project.shareVersion()) return Decision.ALLOW;
    return Decision.SOURCE_UNKNOWN;
  }
}
