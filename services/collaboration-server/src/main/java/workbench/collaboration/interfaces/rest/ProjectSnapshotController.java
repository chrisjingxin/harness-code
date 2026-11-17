package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.SnapshotAppService;
import workbench.collaboration.interfaces.http.ApiResponses;

/** 项目内会话快照的创建与固定版本读取。认证、CSRF 和包络沿用现有用户接口。 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/snapshots")
public class ProjectSnapshotController {
    private final SnapshotAppService snapshots;

    public ProjectSnapshotController(SnapshotAppService snapshots) {
        this.snapshots = snapshots;
    }

    /** 由当前项目成员从指定来源取材，返回创建好的快照供预览。 */
    @PostMapping
    public ResponseEntity<String> create(
            @PathVariable String workspaceId, @PathVariable String projectId, @RequestBody String body) {
        return ApiResponses.json(201, snapshots.create(CurrentSession.userId(), workspaceId, projectId, body));
    }

    /** 按 ID 读取同一份固定材料，成员资格在每次读取时检查。 */
    @GetMapping("/{snapshotId}")
    public ResponseEntity<String> read(
            @PathVariable String workspaceId, @PathVariable String projectId, @PathVariable String snapshotId) {
        return ApiResponses.json(200, snapshots.read(CurrentSession.userId(), workspaceId, projectId, snapshotId));
    }
}
