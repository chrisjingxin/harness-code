package workbench.collaboration.interfaces.rest;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import workbench.collaboration.interfaces.ApiProblem;

/**
 * 模块：当前用户登录会话上下文辅助工具 (CurrentSession)
 *
 * <p>【功能定义】
 * 从当前线程的 Spring Security 上下文（SecurityContextHolder）中安全提取已完成认证的人类用户业务标识（userId）。
 * 遵循安全底线：若未通过前置登录认证或凭证无效，直接抛出 401 AUTHENTICATION_REQUIRED 受控异常。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationController、DeviceController、IdentityController。
 * - 下游依赖方：SecurityContextHolder。
 */
public final class CurrentSession {

    private CurrentSession() {}

    /**
     * 提取当前认证会话的用户唯一业务标识 (UUID)。
     *
     * @return 当前认证用户 ID
     * @throws ApiProblem 401 AUTHENTICATION_REQUIRED 当未登录或上下文缺失时
     */
    public static String userId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
        }
        return authentication.getName();
    }
}
