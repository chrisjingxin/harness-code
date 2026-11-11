package workbench.collaboration.project;

import jakarta.servlet.http.HttpSession;
import jakarta.annotation.PreDestroy;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import workbench.collaboration.Contracts;
import workbench.collaboration.conversation.ConversationStore;
import workbench.collaboration.device.DeviceChannel;
import workbench.collaboration.device.DeviceDtos.ReadableProject;
import workbench.collaboration.device.DeviceService;
import workbench.collaboration.identity.WorkspaceAccess;
import workbench.collaboration.transport.ApiProblem;

import javax.sql.DataSource;
import java.util.concurrent.*;

/**
 * 会话原项目只读链路。
 * 登录和项目授权 → 当前设备派发 → 原设备回包 → 再次授权 → HTTP 响应。
 * 数据库事务不跨设备等待或外部权限检查。
 */
public final class ProjectReadService {
  private static final long LIMIT_NANOS = TimeUnit.SECONDS.toNanos(8);
  private final Contracts contracts;
  private final WorkspaceAccess access;
  private final ConversationStore conversations;
  private final DeviceService devices;
  private final DeviceChannel channel;
  private final ProjectReadAccess sourceAccess;
  private final TransactionTemplate read;
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(0, 128, 30, TimeUnit.SECONDS,
    new SynchronousQueue<>(), task -> { Thread thread = new Thread(task, "project-read"); thread.setDaemon(true); return thread; });

  public ProjectReadService(DataSource source, Contracts contracts, WorkspaceAccess access, ConversationStore conversations,
                            DeviceService devices, DeviceChannel channel, ProjectReadAccess sourceAccess) {
    this.contracts = contracts; this.access = access; this.conversations = conversations;
    this.devices = devices; this.channel = channel; this.sourceAccess = sourceAccess;
    read = new TransactionTemplate(new JdbcTransactionManager(source)); read.setReadOnly(true);
  }

  @PreDestroy public void close() { workers.shutdownNow(); }

  public String read(String userId, String workspaceId, String conversationId, JsonNode action,
                     HttpSession.Accessor session, long startedAt) {
    long deadline = startedAt + LIMIT_NANOS;
    remaining(deadline);
    Future<String> task;
    try {
      task = workers.submit(() -> readWithinDeadline(userId, workspaceId, conversationId, action, session, deadline));
    } catch (RejectedExecutionException busy) { throw new ApiProblem(503, "PROJECT_READ_BUSY"); }
    try {
      return task.get(remaining(deadline), TimeUnit.NANOSECONDS);
    } catch (TimeoutException timedOut) {
      task.cancel(true); workers.remove((Runnable) task);
      throw new ApiProblem(503, "PROJECT_READ_TIMEOUT");
    } catch (InterruptedException interrupted) {
      task.cancel(true); workers.remove((Runnable) task);
      Thread.currentThread().interrupt();
      throw new ApiProblem(503, "PROJECT_READ_TIMEOUT");
    } catch (ExecutionException failure) {
      Throwable cause = failure.getCause();
      if (cause instanceof RuntimeException problem) throw problem;
      throw new ApiProblem(503, "PROJECT_READ_FAILED");
    } finally {
      if (!task.isDone()) { task.cancel(true); workers.remove((Runnable) task); }
    }
  }

  private String readWithinDeadline(String userId, String workspaceId, String conversationId, JsonNode action,
                                    HttpSession.Accessor session, long deadline) {
    requireSession(session, userId);
    ReadableProject target = authorize(userId, workspaceId, conversationId, deadline);
    remaining(deadline);
    try (DeviceChannel.ProjectReadTicket ticket = channel.requestProjectRead(target, action)) {
      JsonNode result;
      try { result = ticket.result().get(remaining(deadline), TimeUnit.NANOSECONDS); }
      catch (TimeoutException timedOut) { throw new ApiProblem(503, "PROJECT_READ_TIMEOUT"); }
      catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        throw new ApiProblem(503, "PROJECT_READ_TIMEOUT");
      } catch (ExecutionException failure) {
        if (failure.getCause() instanceof ApiProblem problem) throw problem;
        throw new ApiProblem(503, "PROJECT_READ_FAILED");
      }
      remaining(deadline);
      requireSession(session, userId);
      ReadableProject current = authorize(userId, workspaceId, conversationId, deadline);
      if (!current.equals(target)) throw new ApiProblem(409, "SHARE_VERSION_CONFLICT");
      requireSession(session, userId);
      remaining(deadline);
      if (!result.path("status").asText().equals("ok")) {
        String code = result.path("code").asText();
        throw new ApiProblem(status(code), code);
      }
      return contracts.encode("ProjectReadResponse", result.path("response"));
    }
  }

  private ReadableProject authorize(String userId, String workspaceId, String conversationId, long deadline) {
    ReadableProject target = read.execute(status -> {
      access.requireMember(workspaceId, userId);
      var conversation = conversations.conversation(conversationId);
      if (!workspaceId.equals(conversation.workspaceId())) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      return devices.requireReadableProject(workspaceId, conversation.deviceId(), conversation.projectId());
    });
    remaining(deadline);
    if (target == null) throw new ApiProblem(503, "PROJECT_AUTH_UNAVAILABLE");
    switch (sourceAccess.authorize(userId, target)) {
      case ALLOW -> { return target; }
      case SOURCE_UNKNOWN -> throw new ApiProblem(503, "PROJECT_SOURCE_UNKNOWN");
      case IDENTITY_UNBOUND -> throw new ApiProblem(403, "PROJECT_IDENTITY_UNBOUND");
      case REPOSITORY_DENIED -> throw new ApiProblem(403, "PROJECT_REPOSITORY_DENIED");
      case AUTH_UNAVAILABLE -> throw new ApiProblem(503, "PROJECT_AUTH_UNAVAILABLE");
      default -> throw new ApiProblem(503, "PROJECT_AUTH_UNAVAILABLE");
    }
  }

  private static void requireSession(HttpSession.Accessor accessor, String userId) {
    try {
      accessor.access(session -> {
        Object value = session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
        if (!(value instanceof SecurityContext context) || context.getAuthentication() == null
          || !context.getAuthentication().isAuthenticated() || !userId.equals(context.getAuthentication().getName()))
          throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
      });
    } catch (IllegalStateException expired) { throw new ApiProblem(401, "AUTHENTICATION_REQUIRED"); }
  }

  private static long remaining(long deadline) {
    long value = deadline - System.nanoTime();
    if (value <= 0 || Thread.currentThread().isInterrupted()) throw new ApiProblem(503, "PROJECT_READ_TIMEOUT");
    return value;
  }

  private static int status(String code) {
    return switch (code) {
      case "PROJECT_PATH_INVALID" -> 400;
      case "PROJECT_FILE_DENIED" -> 403;
      case "PROJECT_FILE_NOT_FOUND" -> 404;
      case "PROJECT_FILE_UNSUPPORTED" -> 422;
      case "PROJECT_NOT_SHARED", "SHARE_VERSION_CONFLICT", "PROJECT_ROOT_CHANGED",
        "PROJECT_FILE_CHANGED", "PROJECT_CURSOR_EXPIRED", "PROJECT_GIT_STALE" -> 409;
      default -> 503;
    };
  }
}
