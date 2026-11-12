package workbench.collaboration.interfaces.stream;

import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.Map;

/**
 * 模块：设备专属 WebSocket 长连接端点配置 (DaemonWebSocketConfig)
 *
 * <p>【功能定义】
 * 注册 Electron Daemon 与服务端的物理双向通信管道（/api/v1/device/channel）。
 * 遵循严格的握手前置准入控制：
 * 在 TCP 握手升级为 WebSocket 之前，通过 HandshakeInterceptor 提取并核验客户端 Authorization 报文头中的 Bearer 凭据；
 * 若凭据不存在、已失效或设备已被吊销，立即返回 HTTP 401 并中止握手，严防未授权连接占用套接字资源。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring WebSocket 框架。
 * - 下游依赖方：DaemonWebSocketHandler、WorkbenchProperties。
 */
@Configuration
@EnableWebSocket
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class DaemonWebSocketConfig implements WebSocketConfigurer {

    private final DaemonWebSocketHandler handler;
    private final String origin;

    public DaemonWebSocketConfig(DaemonWebSocketHandler handler, WorkbenchProperties properties) {
        this.handler = handler;
        this.origin = properties.getOrigin();
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/api/v1/device/channel")
                .addInterceptors(new Handshake())
                .setAllowedOrigins(origin);
    }

    /**
     * WebSocket 握手拦截器：执行设备安全认证与会话属性上下文绑定。
     */
    private final class Handshake implements HandshakeInterceptor {
        @Override
        public boolean beforeHandshake(
                ServerHttpRequest request,
                ServerHttpResponse response,
                WebSocketHandler wsHandler,
                Map<String, Object> attributes
        ) {
            String header = request.getHeaders().getFirst("Authorization");
            try {
                Device device = handler.authenticate(header);
                attributes.put("deviceId", device.id());
                String token = header == null ? "" : header.substring("Bearer ".length());
                attributes.put("bearer", token);
                return true;
            } catch (ApiProblem e) {
                response.setStatusCode(org.springframework.http.HttpStatus.UNAUTHORIZED);
                return false;
            }
        }

        @Override
        public void afterHandshake(
                ServerHttpRequest request,
                ServerHttpResponse response,
                WebSocketHandler wsHandler,
                Exception exception
        ) {}
    }
}
