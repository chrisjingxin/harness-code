package workbench.collaboration.realtime;

import workbench.collaboration.transport.ApiProblem;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import java.util.Collections;
import org.springframework.security.core.Authentication;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** SSE 握手沿同一会话安全链；只接受 afterSequence 或 Last-Event-ID，两者冲突即拒绝。 */
@RestController
public final class ConversationStreamController {
  private final ConversationStreamService streams;
  public ConversationStreamController(ConversationStreamService streams) { this.streams = streams; }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/events", produces = "text/event-stream")
  public ResponseEntity<SseEmitter> events(Authentication auth, HttpServletRequest request, @PathVariable String workspaceId,
                           @PathVariable String conversationId, @RequestParam(required = false) String afterSequence,
                           @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId) {
    String cursor = afterSequence;
    if (lastEventId != null) {
      String prefix = conversationId + ":";
      if (!lastEventId.startsWith(prefix) || Collections.list(request.getHeaders("Last-Event-ID")).size() != 1)
        throw new ApiProblem(400, "INVALID_REQUEST");
      cursor = lastEventId.substring(prefix.length());
      if (afterSequence != null && !afterSequence.equals(cursor)) throw new ApiProblem(400, "INVALID_REQUEST");
    }
    long after;
    try {
      if (cursor != null && !cursor.matches("0|[1-9][0-9]{0,18}")) throw new NumberFormatException();
      after = cursor == null ? 0 : Long.parseLong(cursor);
    } catch (NumberFormatException e) { throw new ApiProblem(400, "INVALID_REQUEST"); }

    HttpSession session = request.getSession(false);
    if (session == null) throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
    HttpSession.Accessor accessor = session.getAccessor();
    if (accessor == null) throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
    return ResponseEntity.ok().contentType(MediaType.TEXT_EVENT_STREAM)
      .body(streams.subscribe(auth.getName(), workspaceId, conversationId, after, session, accessor));
  }
}
