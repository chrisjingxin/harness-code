package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import workbench.collaboration.application.service.KnowledgeAppService;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.PageInput;

/** 团队知识以 Workspace 为权限范围，固定版本可跨该团队的 Project 引用。 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/knowledge")
public class KnowledgeController {
    private final KnowledgeAppService knowledge;

    public KnowledgeController(KnowledgeAppService knowledge) {
        this.knowledge = knowledge;
    }

    @PostMapping
    public ResponseEntity<String> create(@PathVariable String workspaceId, @RequestBody String body) {
        return ApiResponses.json(201, knowledge.create(CurrentSession.userId(), workspaceId, body));
    }

    @GetMapping
    public ResponseEntity<String> list(@PathVariable String workspaceId,
                                       @RequestParam(required = false) String category,
                                       @RequestParam(required = false) String q,
                                       @RequestParam(required = false) String level,
                                       @RequestParam(defaultValue = "all") String scopeMode,
                                       @RequestParam(defaultValue = "") String repositoryIds,
                                       @RequestParam(defaultValue = "") String afterId,
                                       @RequestParam(required = false) String limit) {
        return ApiResponses.json(200, knowledge.list(CurrentSession.userId(), workspaceId, category, q, level, scopeMode, repositoryIds.isEmpty() ? java.util.List.of() : java.util.List.of(repositoryIds.split(",")), afterId,
                PageInput.limit(limit)));
    }

    @GetMapping("/{knowledgeId}")
    public ResponseEntity<String> read(@PathVariable String workspaceId, @PathVariable String knowledgeId) {
        return ApiResponses.json(200, knowledge.read(CurrentSession.userId(), workspaceId, knowledgeId));
    }

    @PutMapping("/{knowledgeId}")
    public ResponseEntity<String> edit(@PathVariable String workspaceId, @PathVariable String knowledgeId,
                                       @RequestBody String body) {
        return ApiResponses.json(200, knowledge.edit(CurrentSession.userId(), workspaceId, knowledgeId, body));
    }

    @DeleteMapping("/{knowledgeId}")
    public ResponseEntity<String> archive(@PathVariable String workspaceId, @PathVariable String knowledgeId,
                                          @RequestParam(required = false) String expectedVersion, @RequestParam String requestId) {
        return ApiResponses.json(200, knowledge.archive(CurrentSession.userId(), workspaceId, knowledgeId,
                PageInput.number(expectedVersion, 1), requestId));
    }

    @GetMapping("/{knowledgeId}/versions")
    public ResponseEntity<String> versions(@PathVariable String workspaceId, @PathVariable String knowledgeId,
                                          @RequestParam(defaultValue = "") String afterId,
                                          @RequestParam(required = false) String limit) {
        return ApiResponses.json(200, knowledge.versions(CurrentSession.userId(), workspaceId, knowledgeId,
                afterId, PageInput.limit(limit)));
    }

    @GetMapping("/{knowledgeId}/versions/{versionId}")
    public ResponseEntity<String> version(@PathVariable String workspaceId, @PathVariable String knowledgeId,
                                         @PathVariable String versionId) {
        return ApiResponses.json(200, knowledge.readVersion(CurrentSession.userId(), workspaceId, knowledgeId, versionId));
    }
}
