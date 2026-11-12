package workbench.collaboration.interfaces.http;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.PlatformDtos;

import java.io.IOException;
import java.util.UUID;

/**
 * 模块：统一 HTTP 响应输出与全局异常网关 (ApiResponses)
 *
 * <p>【功能定义】
 * 提供平台统一的 JSON 成功响应构造器，以及集中式的错误响应渲染网关。
 *
 * <p>【安全与鲁棒性原则 (Why)】
 * 1. 业务错误码与通俗中文对照映射（如 401 "请先登录"、409 "请求编号已用于其他操作" 等）；
 * 2. 身份认证失效作废会话：仅当遇到 AUTHENTICATION_REQUIRED (401) 时才主动 invalidate Session 并清理上下文；
 *    当遇到底层数据库暂时不可用时，返回 503 且绝对不能误把用户登出，确保用户体验连贯；
 * 3. 兜底容错：即使在 Contracts 异常序列化崩溃时，依然使用极简硬编码 JSON 返回 500，杜绝白屏与连接挂死。
 *
 * <p>【协作边界】
 * - 上游调用方：全业务 REST 控制器、BoundaryFilter、WebSecurityConfig。
 * - 下游依赖方：Contracts、PlatformDtos。
 */
public final class ApiResponses {

    private ApiResponses() {}

    /**
     * 构建标准 JSON 格式的 HTTP 响应实体。
     *
     * @param status HTTP 状态码
     * @param body JSON 格式响应正文
     * @return ResponseEntity 实例
     */
    public static ResponseEntity<String> json(int status, String body) {
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).body(body);
    }

    /**
     * 将受控错误渲染为符合 platform/schema 契约的标准 JSON 错误响应。
     */
    public static void failure(
            Contracts contracts,
            HttpServletRequest request,
            HttpServletResponse response,
            int status,
            String code
    ) throws IOException {
        failure(contracts, request, response, status, code, null);
    }

    /**
     * 带序号期望值的受控错误渲染（仅 SEQUENCE_CONFLICT 使用非空 expectedSequence）。
     */
    public static void failure(
            Contracts contracts,
            HttpServletRequest request,
            HttpServletResponse response,
            int status,
            String code,
            Long expectedSequence
    ) throws IOException {
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-store");

        // 仅在明确未认证或登录凭据失效时才清除浏览器登录态，数据库故障等异常不误删会话
        if ("AUTHENTICATION_REQUIRED".equals(code)) {
            var session = request.getSession(false);
            if (session != null) {
                session.invalidate();
            }
            SecurityContextHolder.clearContext();
        }

        String id = response.getHeader("X-Request-Id");
        if (id == null) {
            id = UUID.randomUUID().toString();
            response.setHeader("X-Request-Id", id);
        }
        response.setStatus(status);

        // 统一业务错误通俗中文映射
        String message = switch (code) {
            case "AUTHENTICATION_REQUIRED" -> "请先登录";
            case "DEMO_LOGIN_REJECTED" -> "演示账号不存在或已停用";
            case "CSRF_INVALID" -> "请求凭据已失效，请重试操作";
            case "RESOURCE_NOT_FOUND" -> "资源不可用";
            case "ALREADY_AUTHENTICATED" -> "请先退出当前账号";
            case "SERVICE_UNAVAILABLE" -> "服务连接暂不可用";
            case "REQUEST_SOURCE_REJECTED" -> "请求来源不允许";
            case "PROTOCOL_VERSION_UNSUPPORTED" -> "协议版本不支持";
            case "METHOD_NOT_ALLOWED" -> "请求方法不支持";
            case "UNSUPPORTED_MEDIA_TYPE" -> "请求正文必须使用 JSON";
            case "PAYLOAD_TOO_LARGE" -> "请求体过大";
            case "DEVICE_AUTHENTICATION_REQUIRED" -> "设备凭据已失效";
            case "REQUEST_ID_CONFLICT" -> "请求编号已用于其他操作";
            case "REGISTRATION_CONFLICT" -> "设备标识已被占用";
            case "DEVICE_ACTION_REJECTED" -> "当前账号不能管理该设备";
            case "WORKSPACE_MEMBER_REQUIRED" -> "请先加入该团队";
            case "PROJECT_OWNER_REQUIRED" -> "仅项目负责人可执行该操作";
            case "DEVICE_FORBIDDEN" -> "设备无权执行该操作";
            case "REPOSITORY_CONFLICT" -> "仓库地址已被登记";
            case "VERSION_CONFLICT" -> "数据已被他人修改，请刷新后重试";
            case "PROJECT_ARCHIVED" -> "项目已归档";
            case "REPOSITORY_ARCHIVED" -> "仓库已归档";
            case "OWNER_CANNOT_LEAVE" -> "项目负责人不能移出自己";
            case "SEQUENCE_CONFLICT" -> "消息序号与服务端水位不一致，请按 expectedSequence 续传";
            case "INVALID_REQUEST" -> "请求参数无效";
            default -> "服务暂时无法处理请求";
        };

        String body;
        try {
            body = contracts.encode("ErrorResponse", new PlatformDtos.ErrorResponse(
                    new PlatformDtos.ErrorDetail(code, message, id, status == 503, expectedSequence)
            ));
        } catch (RuntimeException e) {
            response.setStatus(500);
            body = "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"服务暂时无法处理请求\",\"requestId\":\"" + id + "\",\"retryable\":false}}";
        }
        response.getWriter().write(body);
    }

    /**
     * Spring MVC 全局异常切面拦截处理。
     */
    @RestControllerAdvice
    public static class Errors {
        private final Contracts contracts;

        public Errors(Contracts contracts) {
            this.contracts = contracts;
        }

        @ExceptionHandler(ApiProblem.class)
        public void problem(ApiProblem problem, HttpServletRequest request, HttpServletResponse response) throws IOException {
            failure(contracts, request, response, problem.status, problem.code, problem.expectedSequence);
        }

        @ExceptionHandler({DataAccessException.class, CannotCreateTransactionException.class})
        public void unavailable(HttpServletRequest request, HttpServletResponse response) throws IOException {
            failure(contracts, request, response, 503, "SERVICE_UNAVAILABLE");
        }

        @ExceptionHandler(IllegalArgumentException.class)
        public void invalid(HttpServletRequest request, HttpServletResponse response) throws IOException {
            failure(contracts, request, response, 400, "INVALID_REQUEST");
        }
    }
}
