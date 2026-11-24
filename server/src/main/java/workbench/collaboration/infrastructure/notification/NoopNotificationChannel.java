package workbench.collaboration.infrastructure.notification;

import org.springframework.stereotype.Component;
import workbench.collaboration.application.port.ExternalNotificationChannel;
import workbench.collaboration.application.port.ExternalNotificationMessage;

/**
 * 模块：空操作默认外部通知通道 (NoopNotificationChannel)
 *
 * <p>【功能定义】
 * 未配置真实企业自研 IM 时作为默认零副作用通道，直接确认已处理，保证系统开箱零异常。
 */
@Component
public class NoopNotificationChannel implements ExternalNotificationChannel {

    public static final String TYPE = "noop";

    @Override
    public String channelType() {
        return TYPE;
    }

    @Override
    public DeliveryResult send(ExternalNotificationMessage message) {
        return DeliveryResult.sent("noop");
    }
}
