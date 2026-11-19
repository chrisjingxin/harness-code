package workbench.collaboration.interfaces.dto;

import java.util.List;

/**
 * 模块：平台基础与元数据数据传输对象集 (PlatformDtos)
 *
 * <p>【功能定义】
 * 统一定义协作服务在平台基础层面的通用传输对象：
 * 用户展示信息、工作区摘要、演示登录、CSRF 令牌、系统元信息、健康检查以及全局统一响应包络（BeeResponseEntity）。
 *
 * <p>【安全与防御原则 (Why)】
 * 统一响应包络（BeeResponseEntity）以 returnCode 表达调用结果（成功固定 SUC0000，失败为 CLB 分段平台码），
 * errorMsg 承载人类可读提示，body 在失败时携带 ErrorDetail 明细（脱敏业务编码 code、
 * 用于全链路跟踪的 requestId、是否可重试标志 retryable 与断点续传 expectedSequence），
 * 严禁包含任何 Java 异常堆栈、SQL 语句或凭据信息。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityController、BoundaryFilter、ApiResponses、WebSecurityConfig。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class PlatformDtos {

    private PlatformDtos() {}

    /** 普通用户展示身份与所属组织信息 */
    public record UserSummary(
            String id,
            String userNo,
            String userName,
            String photo,
            String orgId,
            String orgNo,
            String orgName,
            String orgPathName
    ) {}

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
    public record DemoLoginRequest(String userNo) {}

    /** CSRF 令牌获取响应 */
    public record CsrfResponse(String headerName, String token) {}

    /** 平台元数据响应 */
    public record MetaResponse(String productVersion, int protocolVersion, String loginMode) {}

    /** 服务健康探测响应 */
    public record HealthResponse(String status) {}

    /**
     * 统一响应包络：所有 HTTP 接口报文的最外层结构。
     * returnCode 成功固定 "SUC0000"，失败为 CLB 分段平台码；body 为业务报文或错误明细。
     */
    public record BeeResponseEntity<T>(String returnCode, String errorMsg, T body) {}

    /** 失败时 body 携带的错误明细（文案由顶层 errorMsg 承载，此处只留机器可分支字段） */
    public record ErrorDetail(
            String code,
            String requestId,
            boolean retryable,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Long expectedSequence
    ) {}

    /** 平台通用消息协议头 */
    public record PlatformMessageHeader(int protocolVersion, String messageId, String type, String occurredAt) {}
}
