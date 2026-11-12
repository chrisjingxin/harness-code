package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.RepositoryAppService;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：团队仓库目录 REST 控制器 (RepositoryController)
 *
 * <p>【功能定义】
 * 团队级仓库目录端点（用户 Session 认证）：登记、按状态过滤列表、
 * 详情（含调用者可见的引用项目）、修改与单向归档。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面工作台。
 * - 下游依赖方：RepositoryAppService、CurrentSession、ApiResponses。
 */
@RestController
public class RepositoryController {

    private final RepositoryAppService repositories;

    public RepositoryController(RepositoryAppService repositories) {
        this.repositories = repositories;
    }

    /** 登记团队仓库目录条目（remoteUrl 全库唯一）。 */
    @PostMapping("/api/v1/workspaces/{workspaceId}/repositories")
    public ResponseEntity<String> create(@PathVariable String workspaceId, @RequestBody String body) {
        return ApiResponses.json(201, repositories.create(CurrentSession.userId(), workspaceId, body));
    }

    /** 团队仓库目录列表，status=active|archived 过滤。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/repositories")
    public ResponseEntity<String> list(
            @PathVariable String workspaceId, @RequestParam(required = false) String status) {
        return ApiResponses.json(200, repositories.list(CurrentSession.userId(), workspaceId, status));
    }

    /** 仓库详情：目录条目 + 调用者可见的引用项目。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/repositories/{repositoryId}")
    public ResponseEntity<String> detail(@PathVariable String workspaceId, @PathVariable String repositoryId) {
        return ApiResponses.json(200, repositories.detail(CurrentSession.userId(), workspaceId, repositoryId));
    }

    /** 修改仓库目录条目（名称/默认分支/归档）。 */
    @PatchMapping("/api/v1/workspaces/{workspaceId}/repositories/{repositoryId}")
    public ResponseEntity<String> patch(
            @PathVariable String workspaceId, @PathVariable String repositoryId, @RequestBody String body) {
        return ApiResponses.json(200, repositories.patch(CurrentSession.userId(), workspaceId, repositoryId, body));
    }
}
