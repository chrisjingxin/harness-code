package workbench.collaboration.infrastructure.notification;

import org.junit.jupiter.api.Test;
import workbench.collaboration.application.port.ExternalActor;
import workbench.collaboration.application.port.ExternalNotificationMessage;
import workbench.collaboration.application.port.ExternalRecipient;

import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 验证 SafeNotificationBuilder 与 WorkbenchSchemeDeepLinkBuilder 的安全底线：
 * 标题单行清洗截断、事件白名单、受控摘要模板、UUID 强校验以及消息载荷零敏感正文字段反射断言。
 */
class SafeNotificationBuilderTest {

    private static final String WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String TASK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    private static final String DELIVERY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    private final WorkbenchSchemeDeepLinkBuilder linkBuilder = new WorkbenchSchemeDeepLinkBuilder();
    private final SafeNotificationBuilder builder = new SafeNotificationBuilder(linkBuilder);

    @Test
    void 标题单行清洗控制字符并按80字截断() {
        assertThat(SafeNotificationBuilder.sanitizeTitle(null)).isEqualTo("未命名事项");
        assertThat(SafeNotificationBuilder.sanitizeTitle(" \n\t\r ")).isEqualTo("未命名事项");
        assertThat(SafeNotificationBuilder.sanitizeTitle("修复\n支付\t对账\r\n异常"))
                .isEqualTo("修复 支付 对账 异常");

        String ninety = "甲".repeat(90);
        String sanitized = SafeNotificationBuilder.sanitizeTitle(ninety);
        assertThat(sanitized).hasSize(80);
        assertThat(sanitized).endsWith("…");
    }

    @Test
    void 单条与合批消息构造正确且载荷严禁包含敏感字段() {
        var recipient = new ExternalRecipient("11111111111141118111111111111111", "80278668", "张景新", "80278668");
        var actor = new ExternalActor("22222222222242228222222222222222", "80278667", "沈北辰\n违规换行");

        ExternalNotificationMessage single = builder.build(
                DELIVERY_ID, "task.assigned", "normal", recipient, actor,
                WS, "平台架构二组", PROJECT, "支付重构\t核心", TASK, "核对\n结算账单", 1, 1000L);

        assertThat(single.actor().userName()).isEqualTo("沈北辰 违规换行");
        assertThat(single.projectName()).isEqualTo("支付重构 核心");
        assertThat(single.title()).isEqualTo("核对 结算账单");
        assertThat(single.summary()).isEqualTo("沈北辰 违规换行 在【支付重构 核心】指派了任务给你：核对 结算账单");
        assertThat(single.deepLink()).isEqualTo(
                "workbench://open/task?workspaceId=" + WS + "&projectId=" + PROJECT + "&taskId=" + TASK);
        assertThat(single.actionLabel()).isEqualTo("在工作台查看");

        ExternalNotificationMessage batch = builder.build(
                DELIVERY_ID, "task.review_requested", "urgent", recipient, actor,
                WS, "平台架构二组", PROJECT, "支付重构", TASK, "核对结算账单任务超过二十四个字截断验证测试文本", 3, 2000L);

        assertThat(batch.mergedCount()).isEqualTo(3);
        assertThat(batch.deepLink()).isEqualTo("workbench://open/inbox");
        assertThat(batch.summary()).startsWith("【支付重构】有 3 项任务待你验收（最近：");

        // 反射断言 ExternalNotificationMessage 绝不存在正文、长描述、代码片段、文件路径或附件等敏感字段
        Set<String> fieldNames = Arrays.stream(ExternalNotificationMessage.class.getRecordComponents())
                .map(RecordComponent::getName)
                .collect(java.util.stream.Collectors.toSet());
        assertThat(fieldNames).doesNotContain(
                "description", "messages", "text", "body", "code", "filePath", "diff", "attachments", "content");
    }

    @Test
    void 拒绝非白名单事件与非UUID跳转参数() {
        var recipient = new ExternalRecipient("11111111111141118111111111111111", "80278668", "张景新", "80278668");
        var actor = new ExternalActor("22222222222242228222222222222222", "80278667", "沈北辰");

        assertThatThrownBy(() -> builder.build(
                DELIVERY_ID, "conversation.message", "normal", recipient, actor,
                WS, "团队", PROJECT, "项目", TASK, "标题", 1, 1000L))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> linkBuilder.buildTaskLink(WS, "not-a-uuid", TASK))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> linkBuilder.buildTaskLink(WS, PROJECT, "../etc/passwd"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
