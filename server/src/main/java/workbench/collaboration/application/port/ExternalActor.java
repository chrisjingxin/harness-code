package workbench.collaboration.application.port;

/**
 * 外部 IM 通知触发操作人脱敏摘要（仅含标识与名称，不含任何私密正文）。
 */
public record ExternalActor(
        String userId,
        String userNo,
        String userName
) {}
