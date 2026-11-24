package workbench.collaboration.interfaces.rest;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import workbench.collaboration.application.service.InboxAppService;
import workbench.collaboration.application.service.NotificationPreferenceAppService;
import workbench.collaboration.application.service.UserNotificationAppService;
import workbench.collaboration.infrastructure.messaging.NotificationSignal;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.PageInput;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 模块：当前登录用户全局收件箱、跨团队通知流与偏好接口控制器 (MeController)
 *
 * <p>【功能定义】
 * 提供 `/api/v1/me/inbox`、`/api/v1/me/notifications`、`/api/v1/me/notifications/stream`
 * 与 `/api/v1/me/notification-preferences` 端点，支撑桌面端全局收件箱与跨团队实时角标刷新。
 */
@RestController
@RequestMapping("/api/v1/me")
public class MeController {
    private static final Logger LOGGER = LoggerFactory.getLogger(MeController.class);
    private static final long STREAM_MS = 60_000;
    private static final long HEARTBEAT_MS = 15_000;

    private final InboxAppService inbox;
    private final UserNotificationAppService userNotifications;
    private final NotificationPreferenceAppService preferences;
    private final NotificationSignal signal;
    private final Semaphore streams = new Semaphore(128);
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    public MeController(InboxAppService inbox, UserNotificationAppService userNotifications,
                        NotificationPreferenceAppService preferences, NotificationSignal signal) {
        this.inbox = inbox;
        this.userNotifications = userNotifications;
        this.preferences = preferences;
        this.signal = signal;
    }

    @GetMapping("/inbox")
    public ResponseEntity<String> inbox(@RequestParam(required = false) String bucket,
                                        @RequestParam(required = false) String category,
                                        @RequestParam(required = false) String workspaceId,
                                        @RequestParam(required = false) String limit) {
        return ApiResponses.json(200, inbox.getInbox(
                CurrentSession.userId(), bucket, category, workspaceId, PageInput.limit(limit, 50, 200)));
    }

    @GetMapping("/notifications")
    public ResponseEntity<String> listNotifications(@RequestParam(required = false) String afterId,
                                                    @RequestParam(required = false) String limit) {
        return ApiResponses.json(200, userNotifications.encodePage(userNotifications.page(
                CurrentSession.userId(), PageInput.number(afterId, 0), PageInput.limit(limit))));
    }

    @GetMapping(value = "/notifications/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> stream(@RequestParam(required = false) String afterId,
                                             @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId,
                                             HttpServletRequest request) {
        String user = CurrentSession.userId();
        long startCursor = PageInput.number(lastEventId != null ? lastEventId : afterId, 0);
        userNotifications.requireActiveUser(user);
        HttpSession session = request.getSession(false);
        if (!NotificationController.signedIn(session, user)) {
            throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
        }
        if (!streams.tryAcquire()) {
            throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
        }

        SseEmitter emitter = new SseEmitter(STREAM_MS);
        AtomicBoolean open = new AtomicBoolean(true);
        emitter.onCompletion(() -> open.set(false));
        emitter.onError(error -> open.set(false));
        emitter.onTimeout(() -> open.set(false));
        try {
            workers.execute(() -> send(user, startCursor, session, emitter, open));
        } catch (RejectedExecutionException stopping) {
            streams.release();
            throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
        }
        NotificationController.markAuthorizedStream(request);
        return ResponseEntity.ok().header("X-Accel-Buffering", "no").body(emitter);
    }

    @GetMapping("/notification-preferences")
    public ResponseEntity<String> getPreferences() {
        return ApiResponses.json(200, preferences.encode(preferences.get(CurrentSession.userId())));
    }

    @PutMapping("/notification-preferences")
    public ResponseEntity<String> updatePreferences(@RequestBody String body) {
        return ApiResponses.json(200, preferences.update(CurrentSession.userId(), body));
    }

    private void send(String user, long startCursor, HttpSession session, SseEmitter emitter, AtomicBoolean open) {
        long end = System.currentTimeMillis() + STREAM_MS;
        long nextHeartbeat = 0;
        boolean writeFailed = false;
        // 保持 startCursor 固定不变，每个活跃 Workspace 独立维护各自游标，防止新团队或慢提交团队漏读。
        Map<String, Long> workspaceCursors = new HashMap<>();
        try {
            while (open.get() && NotificationController.signedIn(session, user) && System.currentTimeMillis() < end) {
                long generation = signal.generation();
                var batch = userNotifications.pollPerWorkspace(user, workspaceCursors, startCursor, 50);
                long now = System.currentTimeMillis();
                if (now >= nextHeartbeat) {
                    emitter.send(SseEmitter.event().comment("heartbeat"));
                    nextHeartbeat = now + HEARTBEAT_MS;
                }
                for (var event : batch.events()) {
                    if (!open.get() || !NotificationController.signedIn(session, user)) return;
                    String payload;
                    try {
                        payload = userNotifications.encodeEvent(event);
                    } catch (RuntimeException invalidEvent) {
                        // 单条异常/契约不合规事件只记日志并跳过，避免阻塞后续合法通知推送或导致客户端无限断线重连。
                        LOGGER.error("跳过不符合契约的跨团队通知事件 id={} workspaceId={} type={}",
                                event.id(), event.workspaceId(), event.type(), invalidEvent);
                        continue;
                    }
                    emitter.send(SseEmitter.event()
                            .id(Long.toString(event.id()))
                            .name(event.type())
                            .data(payload));
                }
                if (!batch.hasMore()) {
                    signal.await(generation);
                }
            }
        } catch (IOException disconnected) {
            writeFailed = true;
        } catch (IllegalStateException | ApiProblem closed) {
            // 连接已关闭或用户账号被停用，客户端重连时重新鉴权并续接游标。
        } catch (InterruptedException stopping) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException failure) {
            LOGGER.warn("跨团队用户通知暂无法读取，连接关闭后可按游标重试", failure);
        } finally {
            try {
                if (!writeFailed) {
                    emitter.complete();
                }
            } finally {
                streams.release();
            }
        }
    }

    @PreDestroy
    void close() {
        workers.shutdownNow();
    }
}
