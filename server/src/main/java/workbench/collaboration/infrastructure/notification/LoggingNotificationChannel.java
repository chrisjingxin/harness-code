package workbench.collaboration.infrastructure.notification;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import workbench.collaboration.application.port.ExternalNotificationChannel;
import workbench.collaboration.application.port.ExternalNotificationMessage;

/**
 * 模块：日志输出外部通知通道 (LoggingNotificationChannel)
 *
 * <p>【功能定义】
 * 将已脱敏的轻卡片摘要、接收人工号与安全 deep-link 打印到结构化日志，
 * 供本地开发与测试环境在无真实 IM 网关时验证出站全链路。
 */
@Component
public class LoggingNotificationChannel implements ExternalNotificationChannel {

    public static final String TYPE = "logging";
    private static final Logger LOGGER = LoggerFactory.getLogger(LoggingNotificationChannel.class);

    @Override
    public String channelType() {
        return TYPE;
    }

    @Override
    public DeliveryResult send(ExternalNotificationMessage message) {
        LOGGER.info(
                "[ExternalIM:logging] deliveryId={} event={} urgency={} recipient={}({}) merged={} summary=\"{}\" link={}",
                message.deliveryId(),
                message.eventType(),
                message.urgency(),
                message.recipient().externalAccountId(),
                message.recipient().userName(),
                message.mergedCount(),
                message.summary(),
                message.deepLink()
        );
        return DeliveryResult.sent("logging:" + message.deliveryId());
    }
}
