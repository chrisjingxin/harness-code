package workbench.collaboration.device;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 当前设备连接的临时事实：只保存本进程内真实 socket 的 connectionId/ready/最近活动。
 * 不持久化连接三元组；Java 重启后一律 offline，恢复由 Runner 主动重连触发。
 */
public final class DevicePresence {
  public record Status(String state, Long lastSeenAt) {}
  private record Entry(String connectionId, boolean ready, long lastSeenMs) {}
  private final Map<String, Entry> entries = new ConcurrentHashMap<>();

  public void connected(String deviceId, String connectionId) {
    entries.put(deviceId, new Entry(connectionId, false, System.currentTimeMillis()));
  }
  public void ready(String deviceId, String connectionId) {
    entries.computeIfPresent(deviceId, (key, value) -> value.connectionId().equals(connectionId)
      ? new Entry(connectionId, true, System.currentTimeMillis()) : value);
  }
  public void touch(String deviceId, String connectionId) {
    entries.computeIfPresent(deviceId, (key, value) -> value.connectionId().equals(connectionId)
      ? new Entry(connectionId, value.ready(), System.currentTimeMillis()) : value);
  }
  /** 旧 socket 的 close 不能清掉新连接。 */
  public void disconnected(String deviceId, String connectionId) {
    entries.computeIfPresent(deviceId, (key, value) -> value.connectionId().equals(connectionId) ? null : value);
  }
  public Status stateOf(String deviceId) {
    Entry entry = entries.get(deviceId);
    if (entry == null) return new Status("offline", null);
    return new Status(entry.ready() ? "ready" : "reconciling", entry.lastSeenMs());
  }
  public boolean isReady(String deviceId) {
    Entry entry = entries.get(deviceId);
    return entry != null && entry.ready();
  }
}
