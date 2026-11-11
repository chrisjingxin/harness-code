package workbench.collaboration.conversation;

import workbench.collaboration.Contracts;
import workbench.collaboration.conversation.ConversationDtos.*;
import org.springframework.http.*;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

/** 共享会话 HTTP：严格路径/查询由 RouteCatalog 前置校验，这里只消费已校验输入。 */
@RestController
public final class ConversationController {
  private final Contracts contracts;
  private final ConversationService service;
  public ConversationController(Contracts contracts, ConversationService service) { this.contracts = contracts; this.service = service; }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/conversations", produces = "application/json")
  public String list(Authentication auth, @PathVariable String workspaceId,
                     @RequestParam(required = false) String limit,
                     @RequestParam(required = false) String beforeCreatedAt,
                     @RequestParam(required = false) String beforeId) {
    return contracts.encode("ConversationListResponse", service.list(auth.getName(), workspaceId, limit, beforeCreatedAt, beforeId));
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/conversations", consumes = "application/json", produces = "application/json")
  public ResponseEntity<String> create(Authentication auth, @PathVariable String workspaceId, @RequestBody String body) {
    CreateConversationRequest request = contracts.decode("CreateConversationRequest", body, CreateConversationRequest.class);
    ConversationService.Outcome<CreateConversationResponse> outcome = service.create(auth.getName(), workspaceId, request);
    return ResponseEntity.status(outcome.created() ? HttpStatus.CREATED : HttpStatus.OK)
      .body(contracts.encode("CreateConversationResponse", outcome.response()));
  }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}", produces = "application/json")
  public String get(Authentication auth, @PathVariable String workspaceId, @PathVariable String conversationId) {
    return contracts.encode("ConversationResponse", service.get(auth.getName(), workspaceId, conversationId));
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/inputs", consumes = "application/json", produces = "application/json")
  public ResponseEntity<String> send(Authentication auth, @PathVariable String workspaceId, @PathVariable String conversationId, @RequestBody String body) {
    SendInputRequest request = contracts.decode("SendInputRequest", body, SendInputRequest.class);
    if (request.text().isBlank()) throw new workbench.collaboration.transport.ApiProblem(400, "INVALID_REQUEST");
    ConversationService.Outcome<InputSavedResponse> outcome = service.sendInput(auth.getName(), workspaceId, conversationId, request);
    return ResponseEntity.status(outcome.created() ? HttpStatus.CREATED : HttpStatus.OK)
      .body(contracts.encode("InputSavedResponse", outcome.response()));
  }

  @PostMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/executions/{executionId}/cancel", consumes = "application/json", produces = "application/json")
  public String cancel(Authentication auth, @PathVariable String workspaceId, @PathVariable String conversationId,
                       @PathVariable String executionId, @RequestBody String body) {
    CancelExecutionRequest request = contracts.decode("CancelExecutionRequest", body, CancelExecutionRequest.class);
    return contracts.encode("CancelExecutionResponse", service.cancel(auth.getName(), workspaceId, conversationId, executionId, request));
  }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/executions/{executionId}", produces = "application/json")
  public String execution(Authentication auth, @PathVariable String workspaceId, @PathVariable String conversationId, @PathVariable String executionId) {
    return contracts.encode("ExecutionResponse", service.execution(auth.getName(), workspaceId, conversationId, executionId));
  }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/history", produces = "application/json")
  public String history(Authentication auth, @PathVariable String workspaceId, @PathVariable String conversationId,
                        @RequestParam(required = false) String afterSequence,
                        @RequestParam(required = false) String throughSequence,
                        @RequestParam(required = false) String limit) {
    return contracts.encode("HistoryResponse", service.history(auth.getName(), workspaceId, conversationId, afterSequence, throughSequence, limit));
  }

  @GetMapping(value = "/api/v1/workspaces/{workspaceId}/requests/{requestId}", produces = "application/json")
  public String receipt(Authentication auth, @PathVariable String workspaceId, @PathVariable String requestId,
                        @RequestParam String operation) {
    return contracts.encode("RequestReceiptResponse", service.receipt(auth.getName(), workspaceId, requestId, operation));
  }
}
