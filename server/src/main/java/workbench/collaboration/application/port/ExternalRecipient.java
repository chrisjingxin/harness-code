package workbench.collaboration.application.port;

/**
 * 外部 IM 通知收件人身份坐标（已通过 ExternalRecipientResolver 解析）。
 *
 * @param userId            工作台内部用户唯一标识
 * @param userNo            员工工号/一号通标识
 * @param userName          用户展示名
 * @param externalAccountId 外部 IM 路由目标账号（默认等于 userNo，企业侧可自定义替换为 IM OpenID/邮箱）
 */
public record ExternalRecipient(
        String userId,
        String userNo,
        String userName,
        String externalAccountId
) {}
