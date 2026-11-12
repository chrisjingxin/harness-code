package workbench.collaboration.interfaces.rest;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.application.service.ProjectAppService;
import workbench.collaboration.interfaces.http.ApiResponses;

/**
 * 模块：业务项目 REST 控制器 (ProjectController)
 *
 * <p>【功能定义】
 * 项目组织面端点（用户 Session 认证）：项目创建/列表/详情/CAS 修改、
 * 成员加入与移出、项目仓库引用的建立与解除。
 * 授权语义全部由 ProjectAccessPolicy 收口：非成员 404、非 owner 写 403、归档写 409。
 *
 * <p>【协作边界】
 * - 上游调用方：前端桌面工作台。
 * - 下游依赖方：ProjectAppService、CurrentSession、ApiResponses。
 */
@RestController
public class ProjectController {

    private final ProjectAppService projects;

    public ProjectController(ProjectAppService projects) {
        this.projects = projects;
    }

    /** 在团队下创建业务项目（创建者成为 owner）。 */
    @PostMapping("/api/v1/workspaces/{workspaceId}/projects")
    public ResponseEntity<String> create(@PathVariable String workspaceId, @RequestBody String body) {
        return ApiResponses.json(201, projects.create(CurrentSession.userId(), workspaceId, body));
    }

    /** 列出调用者参与的项目。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects")
    public ResponseEntity<String> list(@PathVariable String workspaceId) {
        return ApiResponses.json(200, projects.listMine(CurrentSession.userId(), workspaceId));
    }

    /** 项目详情（成员 + 已引用仓库）。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}")
    public ResponseEntity<String> detail(@PathVariable String workspaceId, @PathVariable String projectId) {
        return ApiResponses.json(200, projects.detail(CurrentSession.userId(), workspaceId, projectId));
    }

    /** CAS 修改项目（仅 owner；expectedVersion 必填）。 */
    @PatchMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}")
    public ResponseEntity<String> patch(
            @PathVariable String workspaceId, @PathVariable String projectId, @RequestBody String body) {
        return ApiResponses.json(200, projects.patch(CurrentSession.userId(), workspaceId, projectId, body));
    }

    /** 项目成员列表（含已移出）。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members")
    public ResponseEntity<String> members(@PathVariable String workspaceId, @PathVariable String projectId) {
        return ApiResponses.json(200, projects.listMembers(CurrentSession.userId(), workspaceId, projectId));
    }

    /** 邀请团队成员加入项目（仅 owner）。 */
    @PostMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members")
    public ResponseEntity<String> addMember(
            @PathVariable String workspaceId, @PathVariable String projectId, @RequestBody String body) {
        return ApiResponses.json(200, projects.addMember(CurrentSession.userId(), workspaceId, projectId, body));
    }

    /** 移出项目成员（仅 owner；置 removed 不删行）。 */
    @DeleteMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members/{userId}")
    public ResponseEntity<String> removeMember(
            @PathVariable String workspaceId, @PathVariable String projectId, @PathVariable String userId) {
        return ApiResponses.json(200, projects.removeMember(CurrentSession.userId(), workspaceId, projectId, userId));
    }

    /** 项目仓库引用视图（含调用者本机已克隆设备）。 */
    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories")
    public ResponseEntity<String> repositories(@PathVariable String workspaceId, @PathVariable String projectId) {
        return ApiResponses.json(200, projects.listRepositories(CurrentSession.userId(), workspaceId, projectId));
    }

    /** 建立项目仓库引用（仅 owner；幂等）。 */
    @PutMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories/{repositoryId}")
    public ResponseEntity<String> addReference(
            @PathVariable String workspaceId, @PathVariable String projectId, @PathVariable String repositoryId) {
        projects.addReference(CurrentSession.userId(), workspaceId, projectId, repositoryId);
        return ResponseEntity.noContent().build();
    }

    /** 解除项目仓库引用（仅 owner）。 */
    @DeleteMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/repositories/{repositoryId}")
    public ResponseEntity<String> removeReference(
            @PathVariable String workspaceId, @PathVariable String projectId, @PathVariable String repositoryId) {
        projects.removeReference(CurrentSession.userId(), workspaceId, projectId, repositoryId);
        return ResponseEntity.noContent().build();
    }
}
