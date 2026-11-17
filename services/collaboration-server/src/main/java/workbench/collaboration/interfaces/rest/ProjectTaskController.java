package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import workbench.collaboration.application.service.TaskAppService;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.PageInput;

/** 项目任务的用户侧接口，统一校验和响应包络由 HTTP 边界负责。 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks")
public class ProjectTaskController {
    private final TaskAppService tasks;

    public ProjectTaskController(TaskAppService tasks) {
        this.tasks = tasks;
    }

    @PostMapping
    public ResponseEntity<String> create(@PathVariable String workspaceId, @PathVariable String projectId,
                                          @RequestBody String body) {
        return ApiResponses.json(201, tasks.create(CurrentSession.userId(), workspaceId, projectId, body));
    }

    @GetMapping
    public ResponseEntity<String> list(@PathVariable String workspaceId, @PathVariable String projectId,
                                       @RequestParam(required = false) String assignee,
                                       @RequestParam(required = false) String creator,
                                       @RequestParam(required = false) String status,
                                       @RequestParam(defaultValue = "") String afterId,
                                       @RequestParam(required = false) String limit) {
        return ApiResponses.json(200, tasks.list(CurrentSession.userId(), workspaceId, projectId,
                assignee, creator, status, afterId, PageInput.limit(limit)));
    }

    @GetMapping("/{taskId}")
    public ResponseEntity<String> read(@PathVariable String workspaceId, @PathVariable String projectId,
                                       @PathVariable String taskId) {
        return ApiResponses.json(200, tasks.read(CurrentSession.userId(), workspaceId, projectId, taskId));
    }

    @PatchMapping("/{taskId}")
    public ResponseEntity<String> patch(@PathVariable String workspaceId, @PathVariable String projectId,
                                        @PathVariable String taskId, @RequestBody String body) {
        return ApiResponses.json(200, tasks.patch(CurrentSession.userId(), workspaceId, projectId, taskId, body));
    }

    @PostMapping("/{taskId}/transitions")
    public ResponseEntity<String> transition(@PathVariable String workspaceId, @PathVariable String projectId,
                                              @PathVariable String taskId, @RequestBody String body) {
        return ApiResponses.json(200, tasks.transition(CurrentSession.userId(), workspaceId, projectId, taskId, body));
    }

    @PutMapping("/{taskId}/conversation")
    public ResponseEntity<String> link(@PathVariable String workspaceId, @PathVariable String projectId,
                                       @PathVariable String taskId, @RequestBody String body) {
        return ApiResponses.json(200, tasks.link(CurrentSession.userId(), workspaceId, projectId, taskId, body));
    }
}
