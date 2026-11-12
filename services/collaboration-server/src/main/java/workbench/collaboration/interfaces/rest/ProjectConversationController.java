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
 * 模块：项目内会话只读共享 REST 控制器 (ProjectConversationController)
 *
 * <p>【功能定义】
 * 用户会话侧的项目内会话端点：登记会话头、简报列表/详情、序号增量历史。
 * 项目成员只读共享"已上传"的会话面；写通道在设备侧（DeviceSyncController）。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面工作台。
 * - 下游依赖方：ConversationAppService、CurrentSession、ApiResponses。
 */
@RestController
public class ProjectConversationController {

    private final ConversationAppService conversations;

    public ProjectConversationController(ConversationAppService conversations) {
        this.conversations = conversations;
    }

    /** 项目成员登记会话头（owner=调用者）。 */
    @PostMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations")
    public ResponseEntity<String> register(
            @PathVariable String workspaceId, @PathVariable String projectId, @RequestBody String body) {
        return ApiResponses.json(201, conversations.register(CurrentSession.userId(), workspaceId, projectId, body));
    }

    /** 项目内会话简报列表，可按 ownerId/status 过滤。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations")
    public ResponseEntity<String> list(
            @PathVariable String workspaceId,
            @PathVariable String projectId,
            @RequestParam(required = false) String ownerId,
            @RequestParam(required = false) String status
    ) {
        return ApiResponses.json(200, conversations.list(CurrentSession.userId(), workspaceId, projectId, ownerId, status));
    }

    /** 单条会话简报详情。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}")
    public ResponseEntity<String> detail(
            @PathVariable String workspaceId, @PathVariable String projectId, @PathVariable String conversationId) {
        return ApiResponses.json(200, conversations.detail(CurrentSession.userId(), workspaceId, projectId, conversationId));
    }

    /** 序号增量历史：afterSequence 之后的消息 + 当前水位。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/history")
    public ResponseEntity<String> history(
            @PathVariable String workspaceId,
            @PathVariable String projectId,
            @PathVariable String conversationId,
            @RequestParam(required = false) String afterSequence,
            @RequestParam(required = false) String limit
    ) {
        return ApiResponses.json(200, conversations.history(
                CurrentSession.userId(), workspaceId, projectId, conversationId,
                after(afterSequence), limit(limit)));
    }

    private static long after(String raw) {
        if (raw == null || raw.isEmpty()) {
            return 0;
        }
        long value;
        try {
            value = Long.parseLong(raw);
        } catch (NumberFormatException invalid) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        if (value < 0) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        return value;
    }

    private static int limit(String raw) {
        if (raw == null || raw.isEmpty()) {
            return 100;
        }
        int value;
        try {
            value = Integer.parseInt(raw);
        } catch (NumberFormatException invalid) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        if (value < 1 || value > 500) {
            throw new ApiProblem(400, "INVALID_REQUEST");
        }
        return value;
    }
}
