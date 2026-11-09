package workbench.collaboration.realtime;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpSession;
import jakarta.servlet.http.HttpSessionBindingEvent;
import jakarta.servlet.http.HttpSessionBindingListener;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import workbench.collaboration.Contracts;
import workbench.collaboration.PlatformDtos.ErrorDetail;
import workbench.collaboration.PlatformDtos.ErrorResponse;
import workbench.collaboration.conversation.ConversationDtos.ConversationEvent;
import workbench.collaboration.conversation.ConversationStore;
import workbench.collaboration.identity.WorkspaceAccess;
import workbench.collaboration.transport.ApiProblem;

import javax.sql.DataSource;
import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** 每批读取先核对现有会话/成员，短事务结束后才写网络。数据库连续位置是唯一补齐来源。 */
public final class ConversationStreamService {
  private static final long HEARTBEAT_MS = 15_000;
  private static final long ROTATE_MS = 30 * 60_000L;
  private final TransactionTemplate read;
  private final ConversationStore store;
  private final WorkspaceAccess access;
  private final Contracts contracts;
  private final ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(2, runnable -> {
    Thread thread = new Thread(runnable, "conversation-sse");
    thread.setDaemon(true);
    return thread;
  });

  public ConversationStreamService(DataSource source, ConversationStore store, WorkspaceAccess access, Contracts contracts) {
    this.read = new TransactionTemplate(new JdbcTransactionManager(source));
    this.read.setReadOnly(true);
    this.store = store;
    this.access = access;
    this.contracts = contracts;
    scheduler.setRemoveOnCancelPolicy(true);
  }

  @PreDestroy
  void stop() { scheduler.shutdownNow(); }

  public SseEmitter subscribe(String userId, String workspaceId, String conversationId, long afterSequence,
                              HttpSession session, HttpSession.Accessor accessor) {
    read.executeWithoutResult(status -> {
      access.requireMember(workspaceId, userId);
      var conversation = store.conversation(conversationId);
      if (!conversation.workspaceId().equals(workspaceId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      if (afterSequence > conversation.nextSequence() - 1) throw new ApiProblem(409, "CURSOR_AHEAD");
    });
    SseEmitter emitter = new SseEmitter(ROTATE_MS);
    Pump pump = new Pump(userId, workspaceId, conversationId, afterSequence, accessor, emitter);
    emitter.onCompletion(pump::close);
    emitter.onTimeout(pump::finish);
    emitter.onError(error -> pump.close());
    // 绑定随 HttpSession 失效自动解绑，退出不必等下一次有正文的数据库查询。
    session.setAttribute(pump.bindingKey, pump);
    pump.start();
    return emitter;
  }

  private final class Pump implements HttpSessionBindingListener {
    private final String bindingKey = "workbench.sse." + UUID.randomUUID();
    private final String userId, workspaceId, conversationId;
    private final SseEmitter emitter;
    private final HttpSession.Accessor accessor;
    private final AtomicBoolean closed = new AtomicBoolean();
    private long cursor;
    private long lastHeartbeatAt;
    private volatile ScheduledFuture<?> task;

    Pump(String userId, String workspaceId, String conversationId, long cursor, HttpSession.Accessor accessor, SseEmitter emitter) {
      this.userId = userId;
      this.workspaceId = workspaceId;
      this.conversationId = conversationId;
      this.cursor = cursor;
      this.accessor = accessor;
      this.emitter = emitter;
    }

    void start() {
      task = scheduler.scheduleWithFixedDelay(this::tick, 0, 200, TimeUnit.MILLISECONDS);
      if (closed.get()) task.cancel(false);
    }

    @Override public void valueUnbound(HttpSessionBindingEvent event) {
      if (stopPump()) emitter.complete();
    }

    boolean stopPump() {
      if (!closed.compareAndSet(false, true)) return false;
      if (task != null) task.cancel(false);
      return true;
    }

    void close() {
      if (!stopPump()) return;
      try { accessor.access(session -> session.removeAttribute(bindingKey)); }
      catch (IllegalStateException expired) { /* 容器已释放此会话的全部属性。 */ }
    }

    private void requireSession() {
      try {
        accessor.access(session -> {
          Object value = session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
          if (!(value instanceof SecurityContext context) || context.getAuthentication() == null
            || !userId.equals(context.getAuthentication().getName())) throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
        });
      } catch (IllegalStateException unavailable) {
        throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
      }
    }

    private void tick() {
      if (closed.get()) return;
      try {
        requireSession();
        List<ConversationEvent> batch = read.execute(status -> {
          access.requireMember(workspaceId, userId);
          long through = store.conversation(conversationId).nextSequence() - 1;
          return store.events(conversationId, cursor, through, 32);
        });
        if (closed.get()) return;
        long now = System.currentTimeMillis();
        if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
          emitter.send(SseEmitter.event().comment("heartbeat"));
          lastHeartbeatAt = now;
        }
        for (ConversationEvent event : batch) {
          if (closed.get()) return;
          long sequence = Long.parseLong(event.sequence());
          if (sequence != cursor + 1) { finish(); return; }
          emitter.send(SseEmitter.event().id(conversationId + ":" + sequence).name("conversation.event")
            .data(contracts.encode("ConversationEvent", event)));
          cursor = sequence;
        }
      } catch (ApiProblem denied) {
        problem(denied.code);
      } catch (IOException disconnected) {
        close();
      } catch (RuntimeException unavailable) {
        problem("SERVICE_UNAVAILABLE");
      }
    }

    private void problem(String code) {
      if (closed.get()) return;
      try {
        emitter.send(SseEmitter.event().name("stream.problem").data(contracts.encode("ErrorResponse",
          new ErrorResponse(new ErrorDetail(code, "会话事件流已关闭", UUID.randomUUID().toString(), "SERVICE_UNAVAILABLE".equals(code))))));
      } catch (IOException | IllegalStateException disconnected) {
        // 控制帧写不出去也必须释放订阅，客户端从已应用位置恢复。
      } finally { finish(); }
    }

    private void finish() {
      close();
      emitter.complete();
    }
  }
}
