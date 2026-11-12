package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.ConversationAppService;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：协作会话控制面 REST 控制器 (ConversationController)
 *
 * <p>【功能定义】
 * 提供多人协作会话的生命周期管理 API：
 * 会话列表与分页、创建会话、查看详情、发送提问、请求幂等回执点查、执行状态查询、任务取消以及历史事件补齐拉取。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面协作工作台。
 * - 下游依赖方：ConversationAppService、CurrentSession、ApiResponses。
 */
@RestController
public class ConversationController {

    private final ConversationAppService conversations;

    public ConversationController(ConversationAppService conversations) {
        this.conversations = conversations;
    }

    /**
     * 分页列出指定工作区下的所有协作会话。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/conversations")
    public ResponseEntity<String> list(
            @PathVariable String workspaceId,
            @RequestParam(required = false) String beforeCreatedAt,
            @RequestParam(required = false) String beforeId,
            @RequestParam(required = false) String limit
    ) {
        return ApiResponses.json(200, conversations.list(CurrentSession.userId(), workspaceId, beforeCreatedAt, beforeId, limit(limit, 50, 100)));
    }

    /**
     * 创建一个全新的协作会话。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/conversations")
    public ResponseEntity<String> create(@PathVariable String workspaceId, @RequestBody String body) {
        return ApiResponses.json(201, conversations.create(CurrentSession.userId(), workspaceId, body));
    }

    /**
     * 获取单个会话的控制头详情。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}")
    public ResponseEntity<String> get(@PathVariable String workspaceId, @PathVariable String conversationId) {
        return ApiResponses.json(200, conversations.get(CurrentSession.userId(), workspaceId, conversationId));
    }

    /**
     * 向指定会话发送人类提问输入并触发 Agent 执行任务。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/inputs")
    public ResponseEntity<String> input(
            @PathVariable String workspaceId,
            @PathVariable String conversationId,
            @RequestBody String body
    ) {
        return ApiResponses.json(201, conversations.sendInput(CurrentSession.userId(), workspaceId, conversationId, body));
    }

    /**
     * 根据请求标识与操作类型查询幂等回执。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/requests/{requestId}")
    public ResponseEntity<String> receipt(
            @PathVariable String workspaceId,
            @PathVariable String requestId,
            @RequestParam(required = false) String operation
    ) {
        return ApiResponses.json(200, conversations.receipt(CurrentSession.userId(), workspaceId, requestId, operation));
    }

    /**
     * 查询指定执行流水（Execution）的热状态。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/executions/{executionId}")
    public ResponseEntity<String> execution(
            @PathVariable String workspaceId,
            @PathVariable String conversationId,
            @PathVariable String executionId
    ) {
        return ApiResponses.json(200, conversations.execution(CurrentSession.userId(), workspaceId, conversationId, executionId));
    }

    /**
     * 取消正在排队或执行中的任务。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/executions/{executionId}/cancel")
    public ResponseEntity<String> cancel(
            @PathVariable String workspaceId,
            @PathVariable String conversationId,
            @PathVariable String executionId,
            @RequestBody String body
    ) {
        return ApiResponses.json(200, conversations.cancel(CurrentSession.userId(), workspaceId, conversationId, executionId, body));
    }

    /**
     * 分页查询会话历史事件（按序号区间检索）。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/history")
    public ResponseEntity<String> history(
            @PathVariable String workspaceId,
            @PathVariable String conversationId,
            @RequestParam(required = false) String afterSequence,
            @RequestParam(required = false) String throughSequence,
            @RequestParam(required = false) String limit
    ) {
        return ApiResponses.json(200, conversations.history(CurrentSession.userId(), workspaceId, conversationId, afterSequence, throughSequence, limit(limit, 100, 200)));
    }

    private static int limit(String raw, int fallback, int max) {
        if (raw == null || raw.isEmpty()) {
            return fallback;
        }
        int value = Integer.parseInt(raw);
        if (value < 1 || value > max) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        return value;
    }
}
