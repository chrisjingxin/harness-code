package workbench.collaboration.infrastructure.notification;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Fallback;
import workbench.collaboration.application.port.DeepLinkBuilder;
import workbench.collaboration.application.port.ExternalRecipientResolver;

/**
 * 模块：外部通知扩展点缺省装配 (ExternalNotificationConfig)
 *
 * <p>【功能定义】
 * 注册默认的 {@link UserNoRecipientResolver} 与 {@link WorkbenchSchemeDeepLinkBuilder}，并标注 {@link Fallback}；
 * 企业内部无论以何种扫描顺序提供自定义 Bean（如邮箱/OpenID 寻址或企业网关中转 Deep-Link），
 * 均会确定性地优先覆盖默认实现，无需额外标注 @Primary。
 */
@Configuration
public class ExternalNotificationConfig {

    @Bean
    @Fallback
    ExternalRecipientResolver defaultExternalRecipientResolver() {
        return new UserNoRecipientResolver();
    }

    @Bean
    @Fallback
    DeepLinkBuilder defaultDeepLinkBuilder() {
        return new WorkbenchSchemeDeepLinkBuilder();
    }
}
