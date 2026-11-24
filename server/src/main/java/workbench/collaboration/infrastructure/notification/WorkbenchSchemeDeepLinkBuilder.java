package workbench.collaboration.infrastructure.notification;

import workbench.collaboration.application.port.DeepLinkBuilder;

import java.util.regex.Pattern;

/**
 * 模块：工作台原生协议安全深链接构造器 (WorkbenchSchemeDeepLinkBuilder)
 *
 * <p>【功能定义】
 * 生成标准 {@code workbench://open/...} 只读定位链接，并对全部路由参数执行严格 UUID 白名单校验。
 */
public class WorkbenchSchemeDeepLinkBuilder implements DeepLinkBuilder {

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    );

    @Override
    public String buildTaskLink(String workspaceId, String projectId, String taskId) {
        return "workbench://open/task?workspaceId=" + requireUuid(workspaceId, "workspaceId")
                + "&projectId=" + requireUuid(projectId, "projectId")
                + "&taskId=" + requireUuid(taskId, "taskId");
    }

    @Override
    public String buildInboxLink() {
        return "workbench://open/inbox";
    }

    private static String requireUuid(String value, String field) {
        if (value == null || !UUID_PATTERN.matcher(value).matches()) {
            throw new IllegalArgumentException("非法的跳转链接参数 " + field);
        }
        return value;
    }
}
