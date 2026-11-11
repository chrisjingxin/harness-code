package workbench.collaboration.device;

import workbench.collaboration.device.DeviceDtos.AuthenticatedDevice;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/** 设备升级只认 Authorization: Bearer <deviceId>.<secret>；浏览器 Cookie/CSRF 不能代替设备身份。 */
public final class DeviceHandshakeInterceptor implements HandshakeInterceptor {
  private final DeviceService devices;
  public DeviceHandshakeInterceptor(DeviceService devices) { this.devices = devices; }

  @Override
  public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Map<String, Object> attributes) {
    try {
      if (request.getHeaders().getFirst(HttpHeaders.COOKIE) != null) throw new IllegalArgumentException("设备通道不接受 Cookie");
      AuthenticatedDevice device = devices.authenticate(request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION));
      attributes.put("workbench.device", device);
      return true;
    } catch (RuntimeException failure) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false;
    }
  }

  @Override
  public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Exception exception) {}
}
