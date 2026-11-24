package workbench.collaboration.infrastructure.notification;

import org.springframework.stereotype.Component;
import workbench.collaboration.application.port.DeepLinkBuilder;
import workbench.collaboration.application.port.ExternalActor;
import workbench.collaboration.application.port.ExternalNotificationMessage;
import workbench.collaboration.application.port.ExternalRecipient;

import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 模块：外部轻通知强制白名单安全构造器 (SafeNotificationBuilder)
 *
 * <p>【功能定义】
 * 作为所有发往 {@code ExternalNotificationChannel} 消息的唯一受控构造出口，
 * 强制完成事件白名单校验、控制字符清洗与长度截断、受控摘要模板拼接及只读 Deep-Link 生成。
 *
 * <p>【安全底线 (Zero Content Leakage)】
 * 本类入参不接受任务长描述、会话消息正文、代码片段、文件路径或附件内容，
 * 从源头确保敏感研发正文绝不会外泄到外部 IM。
 */
@Component
public class SafeNotificationBuilder {

    public static final int TITLE_MAX_LENGTH = 80;
    public static final String ACTION_LABEL = "在工作台查看";
    public static final Set<String> ALLOWED_EVENTS = Set.of(
            "task.assigned",
            "task.review_requested",
            "task.returned",
            "notification.test"
    );

    private static final Pattern CONTROL_CHARS = Pattern.compile("[\\p{Cntrl}]+");
    private static final Pattern MULTI_SPACES = Pattern.compile("\\s+");

    private final DeepLinkBuilder deepLinkBuilder;

    public SafeNotificationBuilder(DeepLinkBuilder deepLinkBuilder) {
        this.deepLinkBuilder = Objects.requireNonNull(deepLinkBuilder, "deepLinkBuilder 不能为空");
    }

    /**
     * 对对象标题进行单行清洗并按 80 字截断：去除换行/制表/控制字符并折叠空白。
     */
    public static String sanitizeTitle(String raw) {
        if (raw == null) {
            return "未命名事项";
        }
        String singleLine = MULTI_SPACES.matcher(CONTROL_CHARS.matcher(raw).replaceAll(" ")).replaceAll(" ").strip();
        if (singleLine.isEmpty()) {
            return "未命名事项";
        }
        if (singleLine.length() <= TITLE_MAX_LENGTH) {
            return singleLine;
        }
        return singleLine.substring(0, TITLE_MAX_LENGTH - 1) + "…";
    }

    /**
     * 仅基于受信任的白名单元数据构造外部轻通知载荷。
     */
    public ExternalNotificationMessage build(
            String deliveryId,
            String eventType,
            String urgency,
            ExternalRecipient recipient,
            ExternalActor actor,
            String workspaceId,
            String workspaceName,
            String projectId,
            String projectName,
            String objectId,
            String rawTitle,
            int mergedCount,
            long occurredAtMs
    ) {
        if (eventType == null || !ALLOWED_EVENTS.contains(eventType)) {
            throw new IllegalArgumentException("不允许的外部通知事件类型: " + eventType);
        }
        if (!"normal".equals(urgency) && !"urgent".equals(urgency)) {
            throw new IllegalArgumentException("无效的外部通知紧迫度: " + urgency);
        }
        if (mergedCount < 1) {
            throw new IllegalArgumentException("mergedCount 必须大于等于 1");
        }

        String cleanWorkspace = sanitizeLabel(workspaceName, "所属团队", 80);
        String cleanProject = sanitizeLabel(projectName, "", 80);
        String cleanActorName = sanitizeLabel(actor.userName(), "团队成员", 80);
        String cleanTitle = sanitizeTitle(rawTitle);
        String scopeName = cleanProject.isEmpty() ? cleanWorkspace : cleanProject;

        ExternalActor sanitizedActor = new ExternalActor(
                actor.userId(),
                sanitizeLabel(actor.userNo(), "", 32),
                cleanActorName
        );

        String summary = buildSummary(eventType, cleanActorName, scopeName, cleanTitle, mergedCount);
        String deepLink = (mergedCount == 1
                && projectId != null && !projectId.isEmpty()
                && !"notification.test".equals(eventType))
                ? deepLinkBuilder.buildTaskLink(workspaceId, projectId, objectId)
                : deepLinkBuilder.buildInboxLink();

        return new ExternalNotificationMessage(
                deliveryId,
                eventType,
                urgency,
                recipient,
                sanitizedActor,
                workspaceId,
                cleanWorkspace,
                projectId == null ? "" : projectId,
                cleanProject,
                cleanTitle,
                summary,
                ACTION_LABEL,
                deepLink,
                mergedCount,
                occurredAtMs
        );
    }

    private static String buildSummary(String eventType, String actorName, String scopeName,
                                       String cleanTitle, int mergedCount) {
        if (mergedCount > 1) {
            String shortTitle = truncate(cleanTitle, 24);
            return switch (eventType) {
                case "task.assigned" -> "【" + scopeName + "】有 " + mergedCount + " 项新任务指派给你（最近：" + shortTitle + "）";
                case "task.review_requested" -> "【" + scopeName + "】有 " + mergedCount + " 项任务待你验收（最近：" + shortTitle + "）";
                case "task.returned" -> "【" + scopeName + "】有 " + mergedCount + " 项任务被退回修改（最近：" + shortTitle + "）";
                case "notification.test" -> "【" + scopeName + "】有 " + mergedCount + " 条外部通知测试";
                default -> throw new IllegalArgumentException("不允许的外部通知事件类型: " + eventType);
            };
        }
        return switch (eventType) {
            case "task.assigned" -> actorName + " 在【" + scopeName + "】指派了任务给你：" + cleanTitle;
            case "task.review_requested" -> actorName + " 在【" + scopeName + "】提交了待你验收的任务：" + cleanTitle;
            case "task.returned" -> actorName + " 在【" + scopeName + "】退回修改任务：" + cleanTitle;
            case "notification.test" -> "【" + scopeName + "】发送了一条外部通知连通性测试";
            default -> throw new IllegalArgumentException("不允许的外部通知事件类型: " + eventType);
        };
    }

    private static String sanitizeLabel(String raw, String fallback, int maxLen) {
        if (raw == null) {
            return fallback;
        }
        String clean = MULTI_SPACES.matcher(CONTROL_CHARS.matcher(raw).replaceAll(" ")).replaceAll(" ").strip();
        if (clean.isEmpty()) {
            return fallback;
        }
        return truncate(clean, maxLen);
    }

    private static String truncate(String text, int maxLen) {
        if (text.length() <= maxLen) {
            return text;
        }
        return text.substring(0, maxLen - 1) + "…";
    }
}
