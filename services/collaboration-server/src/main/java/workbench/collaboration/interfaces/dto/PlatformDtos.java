package workbench.collaboration.interfaces.dto;

import java.util.List;

/**
 * 模块：平台基础与元数据数据传输对象集 (PlatformDtos)
 *
 * <p>【功能定义】
 * 统一定义协作服务在平台基础层面的通用传输对象：
 * 用户展示信息、工作区摘要、演示登录、CSRF 令牌、系统元信息、健康检查以及全局统一受控错误结构（ErrorResponse）。
 *
 * <p>【安全与防御原则 (Why)】
 * 统一错误返回对象（ErrorResponse / ErrorDetail）只携带脱敏业务编码 code、人类可读提示 message、
 * 用于全链路跟踪的 requestId 以及是否可重试标志 retryable，严禁包含任何 Java 异常堆栈、SQL 语句或凭据信息。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityController、BoundaryFilter、ApiResponses、WebSecurityConfig。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class PlatformDtos {

    private PlatformDtos() {}

    /** 普通用户展示身份信息 */
    public record UserSummary(String id, String username, String displayName) {}

    /** 工作区展示资料 */
    public record WorkspaceSummary(String id, String slug, String name) {}

    /** 工作区成员摘要 */
    public record MemberSummary(UserSummary user) {}

    /** 当前登录用户及其工作区响应 */
    public record CurrentUserResponse(UserSummary user, List<WorkspaceSummary> workspaces) {}

    /** 可选演示账号列表响应 */
    public record DemoUsersResponse(List<UserSummary> users) {}

    /** 工作区列表响应 */
    public record WorkspaceListResponse(List<WorkspaceSummary> workspaces) {}

    /** 成员列表响应 */
    public record MembersResponse(String workspaceId, List<MemberSummary> members) {}

    /** 演示快捷登录请求 */
    public record DemoLoginRequest(String username) {}

    /** CSRF 令牌获取响应 */
    public record CsrfResponse(String headerName, String token) {}

    /** 平台元数据响应 */
    public record MetaResponse(String productVersion, int protocolVersion, String loginMode) {}

    /** 服务健康探测响应 */
    public record HealthResponse(String status) {}

    /** 统一业务错误详情 */
    public record ErrorDetail(String code, String message, String requestId, boolean retryable) {}

    /** 统一业务错误响应顶层封包 */
    public record ErrorResponse(ErrorDetail error) {}

    /** 平台通用消息协议头 */
    public record PlatformMessageHeader(int protocolVersion, String messageId, String type, String occurredAt) {}
}
