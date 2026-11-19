package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.BoardAppService;
import workbench.collaboration.interfaces.http.ApiResponses;

/** 读取项目看板的入口。设备在线只供界面展示。 */
@RestController
public class ProjectBoardController {
    private final BoardAppService board;

    public ProjectBoardController(BoardAppService board) {
        this.board = board;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/board")
    public ResponseEntity<String> read(@PathVariable String workspaceId, @PathVariable String projectId) {
        return ApiResponses.json(200, board.read(CurrentSession.userId(), workspaceId, projectId));
    }
}
