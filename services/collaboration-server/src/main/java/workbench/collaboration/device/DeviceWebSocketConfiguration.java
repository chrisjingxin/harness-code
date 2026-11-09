package workbench.collaboration.device;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/** 唯一设备通道；不允许通配路径或第二套 Upgrade 入口。 */
@Configuration(proxyBeanMethods = false)
@EnableWebSocket
public final class DeviceWebSocketConfiguration implements WebSocketConfigurer {
  private final DeviceChannel channel;
  private final DeviceHandshakeInterceptor interceptor;
  public DeviceWebSocketConfiguration(DeviceChannel channel, DeviceHandshakeInterceptor interceptor) {
    this.channel = channel; this.interceptor = interceptor;
  }
  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(channel, "/api/v1/device/channel")
      .addInterceptors(interceptor)
      .setAllowedOriginPatterns("*");
  }
}
