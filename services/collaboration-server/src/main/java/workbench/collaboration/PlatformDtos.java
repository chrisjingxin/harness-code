package workbench.collaboration;

import java.util.List;

/** 线上基础 DTO 的 Java 消费形状；真正接收/发送边界仍由同源 schema 校验。 */
public final class PlatformDtos {
  private PlatformDtos() {}
  /** 普通用户展示身份，不代表岗位或设备所有权。 */
  public record UserSummary(String id, String username, String displayName) {}
  /** 工作区展示资料，slug 不能授予访问权。 */
  public record WorkspaceSummary(String id, String slug, String name) {}
  public record MemberSummary(UserSummary user) {}
  public record CurrentUserResponse(UserSummary user, List<WorkspaceSummary> workspaces) {}
  public record DemoUsersResponse(List<UserSummary> users) {}
  public record WorkspaceListResponse(List<WorkspaceSummary> workspaces) {}
  public record MembersResponse(String workspaceId, List<MemberSummary> members) {}
  public record DemoLoginRequest(String username) {}
  /** token 只给主进程，不属于 UI 返回值。 */
  public record CsrfResponse(String headerName, String token) {}
  public record MetaResponse(String productVersion, int protocolVersion, String loginMode) {}
  public record HealthResponse(String status) {}
  /** requestId 可查诊断，不携带堆栈或数据库凭据。 */
  public record ErrorDetail(String code, String message, String requestId, boolean retryable) {}
  public record ErrorResponse(ErrorDetail error) {}
  /** 只有头部；后续业务须登记完整载荷后才能受理。 */
  public record PlatformMessageHeader(int protocolVersion, String messageId, String type, String occurredAt) {}
}
