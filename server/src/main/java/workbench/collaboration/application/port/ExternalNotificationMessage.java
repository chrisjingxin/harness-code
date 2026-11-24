package workbench.collaboration.application.port;

import java.util.Objects;

/**
 * 模块：脱敏外部通知轻卡片标准载荷 (ExternalNotificationMessage)
 *
 * <p>【安全底线 (Zero Content Leakage)】
 * 本载荷仅允许由基础设施 {@code SafeNotificationBuilder} 构造，严格限定为受控白名单元数据：
 * 严禁包含任务长描述、会话消息正文、代码片段、本机路径、Diff 或附件内容。
 */
public record ExternalNotificationMessage(
        String deliveryId,
        String eventType,
        String urgency,
        ExternalRecipient recipient,
        ExternalActor actor,
        String workspaceId,
        String workspaceName,
        String projectId,
        String projectName,
        String title,
        String summary,
        String actionLabel,
        String deepLink,
        int mergedCount,
        long occurredAtMs
) {
    public ExternalNotificationMessage {
        Objects.requireNonNull(deliveryId, "deliveryId 不能为空");
        Objects.requireNonNull(eventType, "eventType 不能为空");
        Objects.requireNonNull(urgency, "urgency 不能为空");
        Objects.requireNonNull(recipient, "recipient 不能为空");
        Objects.requireNonNull(actor, "actor 不能为空");
        Objects.requireNonNull(workspaceId, "workspaceId 不能为空");
        workspaceName = workspaceName == null ? "" : workspaceName;
        projectId = projectId == null ? "" : projectId;
        projectName = projectName == null ? "" : projectName;
        Objects.requireNonNull(title, "title 不能为空");
        Objects.requireNonNull(summary, "summary 不能为空");
        Objects.requireNonNull(actionLabel, "actionLabel 不能为空");
        Objects.requireNonNull(deepLink, "deepLink 不能为空");
        if (mergedCount < 1) {
            throw new IllegalArgumentException("mergedCount 必须大于等于 1");
        }
    }
}
