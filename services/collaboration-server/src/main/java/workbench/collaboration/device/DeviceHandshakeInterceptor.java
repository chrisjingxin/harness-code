package workbench.collaboration.device;

import workbench.collaboration.device.DeviceDtos.AuthenticatedDevice;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;
import java.util.List;

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
      attributes.put("workbench.projectRead", supportsProjectRead(request.getHeaders().get("X-Workbench-Device-Capabilities")));
      return true;
    } catch (RuntimeException failure) {
      response.setStatusCode(HttpStatus.UNAUTHORIZED);
      return false;
    }
  }

  /** 声明仅影响此连接的消息兼容性，不授予项目权限。 */
  public static boolean supportsProjectRead(List<String> headers) {
    if (headers == null || headers.size() != 1) return false;
    String raw = headers.getFirst();
    if (raw == null || raw.length() > 256 || !raw.matches("[\\x00-\\x7F]*")) return false;
    boolean found = false;
    for (String part : raw.split(",", -1)) {
      String name = part.replaceAll("^[ \\t]+|[ \\t]+$", "");
      if (!name.matches("[a-z0-9._-]{1,64}")) return false;
      if (name.equals("project.read")) found = true;
    }
    return found;
  }

  @Override
  public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler handler, Exception exception) {}
}
