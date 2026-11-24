package workbench.collaboration.application.port;

import java.util.Objects;

/**
 * 模块：面向企业自研 IM 的可插拔外部通知投递接口 (ExternalNotificationChannel)
 *
 * <p>【功能定义】
 * 这是企业侧对接自研 IM 时**唯一必须实现**的消息投递扩展口子。
 * 合批合并、免打扰顺延、发送前现态复核消噪、白名单脱敏卡片构造、工号寻址与指数退避重试
 * 均已由出站调度引擎内置完成，通道实现只需专注向企业 IM 发送标准轻通知卡片。
 *
 * <p>【企业内 3 步快速接入示例】
 * <pre>{@code
 * // 第 1 步：实现 ExternalNotificationChannel 并注册为 Spring Bean
 * @Component
 * public class CorpImNotificationChannel implements ExternalNotificationChannel {
 *     @Override
 *     public String channelType() { return "corp-im"; }
 *
 *     @Override
 *     public DeliveryResult send(ExternalNotificationMessage msg) {
 *         // 使用 msg.recipient().externalAccountId()（默认即为 wb_user.user_no 工号）
 *         // 发送 msg.title()、msg.summary() 与只读跳转链接 msg.deepLink()
 *         return DeliveryResult.sent(externalMsgId);
 *     }
 * }
 *
 * // 第 2 步（可选）：若需将 workbench:// 包装为企业内网中转页，自定义 DeepLinkBuilder Bean 即可；
 * // 若需用邮箱或独立 OpenID 替代工号寻址，自定义 ExternalRecipientResolver Bean 即可。
 *
 * // 第 3 步：在 application.yml 启用出站引擎并指定通道
 * // workbench.notifications.external.enabled: true
 * // workbench.notifications.external.channel: corp-im
 * }</pre>
 */
public interface ExternalNotificationChannel {

    /**
     * 外部通道投递密封结果：明确区分成功、可退避重试的瞬时故障、以及不可恢复的永久故障。
     */
    sealed interface DeliveryResult permits DeliveryResult.Sent, DeliveryResult.RetryableFailure, DeliveryResult.PermanentFailure {

        record Sent(String externalMessageId) implements DeliveryResult {
            public Sent {
                externalMessageId = externalMessageId == null ? "" : externalMessageId;
            }
        }

        record RetryableFailure(String reason) implements DeliveryResult {
            public RetryableFailure {
                reason = reason == null || reason.isBlank() ? "retryable_failure" : reason;
            }
        }

        record PermanentFailure(String reason) implements DeliveryResult {
            public PermanentFailure {
                reason = reason == null || reason.isBlank() ? "permanent_failure" : reason;
            }
        }

        static DeliveryResult sent(String externalMessageId) {
            return new Sent(externalMessageId);
        }

        static DeliveryResult retryableFailure(String reason) {
            return new RetryableFailure(reason);
        }

        static DeliveryResult permanentFailure(String reason) {
            return new PermanentFailure(Objects.requireNonNullElse(reason, "permanent_failure"));
        }
    }

    /** 通道唯一标识（例如 "noop"、"logging"、"corp-im"），与配置项 workbench.notifications.external.channel 匹配。 */
    String channelType();

    /**
     * 发送一条已完成白名单脱敏校验、频控合批与现态复核的标准轻通知卡片。
     * 注意：本方法在数据库事务之外执行；抛出未捕获异常时将由调度器兜底视为可重试故障。
     */
    DeliveryResult send(ExternalNotificationMessage message);
}
