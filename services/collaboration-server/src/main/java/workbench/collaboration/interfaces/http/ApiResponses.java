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

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;

/**
 * 模块：统一 HTTP 响应输出与全局异常网关 (ApiResponses)
 *
 * <p>【功能定义】
 * 提供平台统一的 BeeResponseEntity 包络响应构造器，以及集中式的错误响应渲染网关。
 * 所有 HTTP 报文最外层固定为 {returnCode, errorMsg, body} 三字段结构：
 * 成功 returnCode=SUC0000、body 为业务报文；失败 returnCode=CLB 分段平台码、body 为 ErrorDetail。
 *
 * <p>【安全与鲁棒性原则 (Why)】
 * 1. 业务错误码与通俗中文对照映射（如 401 "请先登录"、409 "请求编号已用于其他操作" 等）；
 *    内部语义码（ApiProblem.code）仅作 Java 内部词汇，出网前翻译成对外 CLB 平台码，两套词汇解耦；
 * 2. 身份认证失效作废会话：仅当遇到 AUTHENTICATION_REQUIRED (401) 时才主动 invalidate Session 并清理上下文；
 *    当遇到底层数据库暂时不可用时，返回 503 且绝对不能误把用户登出，确保用户体验连贯；
 * 3. 兜底容错：即使在 Contracts 异常序列化崩溃时，依然使用极简硬编码 JSON 返回 500，杜绝白屏与连接挂死。
 *
 * <p>【协作边界】
 * - 上游调用方：全业务 REST 控制器、BoundaryFilter、WebSecurityConfig。
 * - 下游依赖方：Contracts、PlatformDtos。
 */
public final class ApiResponses {

    /** 成功固定返回码 */
    public static final String SUC_CODE = "SUC0000";

    /**
     * 内部语义错误码 → 对外 CLB 平台码（CLB + 类别位 + 3 位序号）。
     * CLB0 请求格式、CLB1 认证会话、CLB2 授权成员、CLB3 资源状态、CLB4 流量预留、CLB5 服务端。
     * 未登记的语义码兜底 CLB5999，避免内部词汇直接泄漏为对外码。
     */
    private static final Map<String, String> CODE_TO_RETURN_CODE = Map.ofEntries(
            Map.entry("INVALID_REQUEST", "CLB0001"),
            Map.entry("METHOD_NOT_ALLOWED", "CLB0002"),
            Map.entry("PAYLOAD_TOO_LARGE", "CLB0003"),
            Map.entry("UNSUPPORTED_MEDIA_TYPE", "CLB0004"),
            Map.entry("PROTOCOL_VERSION_UNSUPPORTED", "CLB0005"),
            Map.entry("AUTHENTICATION_REQUIRED", "CLB1001"),
            Map.entry("DEVICE_AUTHENTICATION_REQUIRED", "CLB1002"),
            Map.entry("DEMO_LOGIN_REJECTED", "CLB1003"),
            Map.entry("CSRF_INVALID", "CLB1004"),
            Map.entry("ALREADY_AUTHENTICATED", "CLB1005"),
            Map.entry("REQUEST_SOURCE_REJECTED", "CLB2001"),
            Map.entry("DEVICE_FORBIDDEN", "CLB2002"),
            Map.entry("WORKSPACE_MEMBER_REQUIRED", "CLB2003"),
            Map.entry("PROJECT_OWNER_REQUIRED", "CLB2004"),
            Map.entry("DEVICE_ACTION_REJECTED", "CLB2005"),
            Map.entry("OWNER_CANNOT_LEAVE", "CLB2006"),
            Map.entry("RESOURCE_NOT_FOUND", "CLB3001"),
            Map.entry("VERSION_CONFLICT", "CLB3002"),
            Map.entry("SEQUENCE_CONFLICT", "CLB3003"),
            Map.entry("REGISTRATION_CONFLICT", "CLB3004"),
            Map.entry("REPOSITORY_CONFLICT", "CLB3005"),
            Map.entry("PROJECT_ARCHIVED", "CLB3006"),
            Map.entry("REPOSITORY_ARCHIVED", "CLB3007"),
            Map.entry("REQUEST_ID_CONFLICT", "CLB3008"),
            Map.entry("INTERNAL_ERROR", "CLB5001"),
            Map.entry("SERVICE_UNAVAILABLE", "CLB5002")
    );

    private ApiResponses() {}

    /** 包络专用序列化器：body 已是契约编码后的 JSON，按 JsonNode 原样嵌入，不做内容改写 */
    private static final ObjectMapper ENVELOPE_MAPPER = new ObjectMapper();

    /**
     * 将已按契约编码的业务报文包入成功包络。
     * body 一律经 Contracts.encode 校验为合法 JSON，解析为 JsonNode 后由 BeeResponseEntity 泛型承载，
     * 通过 Jackson 整体序列化，杜绝手写 JSON 拼接。
     */
    public static String envelope(String encodedBody) {
        try {
            JsonNode body = ENVELOPE_MAPPER.readTree(encodedBody);
            return ENVELOPE_MAPPER.writeValueAsString(new PlatformDtos.BeeResponseEntity<>(SUC_CODE, "", body));
        } catch (IOException error) {
            throw new IllegalStateException("无法构造响应包络", error);
        }
    }

    /**
     * 构建标准 JSON 格式的 HTTP 响应实体（成功包络）。
     *
     * @param status HTTP 状态码
     * @param body 已编码的 JSON 格式业务正文（由 Contracts.encode 产出）
     * @return ResponseEntity 实例
     */
    public static ResponseEntity<String> json(int status, String body) {
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).body(envelope(body));
    }

    /**
     * 过滤器/登录登出处理器场景的直接成功包络写出（无 ResponseEntity 上下文）。
     * 无业务体时调用方传 "null" 作为 encodedBody。
     */
    public static void success(HttpServletResponse response, String encodedBody) throws IOException {
        response.setStatus(200);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        response.getWriter().write(envelope(encodedBody));
    }

    /**
     * 将受控错误渲染为符合 platform/schema 契约的 BeeResponseEntity 错误包络。
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

        String returnCode = CODE_TO_RETURN_CODE.getOrDefault(code, "CLB5999");
        String body;
        try {
            body = contracts.encode("ErrorEnvelope", new PlatformDtos.BeeResponseEntity<>(
                    returnCode, message, new PlatformDtos.ErrorDetail(code, id, status == 503, expectedSequence)
            ));
        } catch (RuntimeException e) {
            response.setStatus(500);
            body = "{\"returnCode\":\"CLB5001\",\"errorMsg\":\"服务暂时无法处理请求\",\"body\":{\"code\":\"INTERNAL_ERROR\",\"requestId\":\"" + id + "\",\"retryable\":false}}";
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
