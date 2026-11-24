package workbench.collaboration.application.port;

import workbench.collaboration.domain.identity.User;

import java.util.Optional;

/**
 * 模块：外部 IM 收件人身份寻址扩展接口 (ExternalRecipientResolver)
 *
 * <p>【功能定义】
 * 将工作台内部 {@link User} 映射为企业 IM 可识别的收件人坐标。
 * 默认实现直接读取 {@code wb_user.user_no}（员工工号）；返回 {@link Optional#empty()} 时，
 * 引擎跳过投递并记录 {@code skip_reason="recipient_unmapped"}。
 */
public interface ExternalRecipientResolver {

    Optional<ExternalRecipient> resolve(User user);
}
