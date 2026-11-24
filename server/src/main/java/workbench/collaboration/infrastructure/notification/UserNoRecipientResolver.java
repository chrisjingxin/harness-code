package workbench.collaboration.infrastructure.notification;

import workbench.collaboration.application.port.ExternalRecipient;
import workbench.collaboration.application.port.ExternalRecipientResolver;
import workbench.collaboration.domain.identity.User;

import java.util.Optional;

/**
 * 模块：基于员工工号（wb_user.user_no）的默认外部收件人解析器 (UserNoRecipientResolver)
 *
 * <p>【功能定义】
 * 直接透传启用账号的 {@code wb_user.user_no} 作为外部 IM 收件坐标；
 * 若账号已停用或未绑定工号，返回 empty 由调度器跳过投递。
 */
public class UserNoRecipientResolver implements ExternalRecipientResolver {

    @Override
    public Optional<ExternalRecipient> resolve(User user) {
        if (user == null || !user.enabled() || user.userNo() == null || user.userNo().isBlank()) {
            return Optional.empty();
        }
        String userNo = user.userNo().strip();
        return Optional.of(new ExternalRecipient(user.id(), userNo, user.userName(), userNo));
    }
}
