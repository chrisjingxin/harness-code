package workbench.collaboration.interfaces;

/**
 * 模块：统一业务受控异常模型 (ApiProblem)
 *
 * <p>【功能定义】
 * 描述平台对外暴露的结构化受控业务异常（包含 HTTP 状态码与大写下划线错误编码）。
 * 遵循安全与防御规范：服务端拦截器与业务服务仅抛出此类受控异常，
 * 全局异常处理网关（ApiResponses）将其格式化为标准 ErrorResponse，
 * 彻底防止数据库错误、系统堆栈或敏感配置泄漏到客户端响应中。
 *
 * <p>【协作边界】
 * - 上游调用方：全业务服务层（ConversationAppService、DeviceAppService、IdentityAppService）、BoundaryFilter。
 * - 下游依赖方：ApiResponses。
 */
public final class ApiProblem extends RuntimeException {

    /** HTTP 响应状态码（如 400, 401, 403, 404, 409） */
    public final int status;

    /** 平台统一业务错误码（如 "REQUEST_ID_CONFLICT", "RESOURCE_NOT_FOUND"） */
    public final String code;

    public ApiProblem(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
