package workbench.collaboration.interfaces.rest;

import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import workbench.collaboration.application.service.WorkspaceAppService;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.PageInput;

/** 团队管理具名路由；权限、版本、交接完整性在服务事务中核验。 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}")
public class WorkspaceController {
    private final WorkspaceAppService service;
    public WorkspaceController(WorkspaceAppService service) {this.service=service;}
    @GetMapping("/access")
    public ResponseEntity<String> access(@PathVariable String workspaceId) {return ApiResponses.json(200,service.access(CurrentSession.userId(),workspaceId));}
    @PostMapping("/members")
    public ResponseEntity<String> add(@PathVariable String workspaceId,@RequestBody String body) {return ApiResponses.json(200,service.add(CurrentSession.userId(),workspaceId,body));}
    @PatchMapping("/members/{userId}/role")
    public ResponseEntity<String> role(@PathVariable String workspaceId,@PathVariable String userId,@RequestBody String body) {return ApiResponses.json(200,service.role(CurrentSession.userId(),workspaceId,userId,body));}
    @GetMapping("/members/{userId}/removal-preview")
    public ResponseEntity<String> preview(@PathVariable String workspaceId,@PathVariable String userId,
            @RequestParam(required=false) String afterId,@RequestParam(required=false) String limit,@RequestParam(required=false) String previewVersion) {
        return ApiResponses.json(200,service.preview(CurrentSession.userId(),workspaceId,userId,afterId,PageInput.limit(limit),previewVersion));
    }
    @PostMapping("/members/{userId}/removal")
    public ResponseEntity<String> remove(@PathVariable String workspaceId,@PathVariable String userId,@RequestBody String body) {return ApiResponses.json(200,service.remove(CurrentSession.userId(),workspaceId,userId,body));}
}
