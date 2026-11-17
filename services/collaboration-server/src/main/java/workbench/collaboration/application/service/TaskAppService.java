package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.snapshot.SnapshotRepository;
import workbench.collaboration.domain.task.TaskStatus;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.KnowledgeStore;
import workbench.collaboration.infrastructure.persistence.TaskStore;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import static workbench.collaboration.interfaces.dto.TaskDtos.*;

/**
 * 项目任务的用户操作入口。成员授权 → 请求回执 → 版本及角色核对 → 落库与审计。
 * 关联仅记录已登记的本人会话。任何操作都不改变会话执行状态。
 */
@Service
public class TaskAppService {
    private final ProjectAccessPolicy policy;
    private final IdentityRepository identity;
    private final ConversationRepository conversations;
    private final SnapshotRepository snapshots;
    private final KnowledgeStore knowledge;
    private final TaskStore tasks;
    private final NotificationPort notifications;
    private final Contracts contracts;

    public TaskAppService(ProjectAccessPolicy policy, IdentityRepository identity, ConversationRepository conversations,
                          SnapshotRepository snapshots, KnowledgeStore knowledge, TaskStore tasks,
                          NotificationPort notifications, Contracts contracts) {
        this.policy = policy;
        this.identity = identity;
        this.conversations = conversations;
        this.snapshots = snapshots;
        this.knowledge = knowledge;
        this.tasks = tasks;
        this.notifications = notifications;
        this.contracts = contracts;
    }

    @Transactional
    public String create(String actor, String workspace, String project, String body) {
        authorize(actor, workspace, project, true);
        var request = contracts.decode("TaskCreateRequest", body, TaskCreateRequest.class);
        return write(project, actor, request.requestId(), IdempotentCalls.fingerprint("create", body), () -> {
            String assignee = request.assigneeId();
            policy.requireActiveMember(project, assignee);
            if (!identity.memberExists(workspace, assignee) || identity.findUserById(assignee).filter(User::enabled).isEmpty()) {
                throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
            }
            var snapshotIds = request.snapshotIds() == null ? List.<String>of() : request.snapshotIds();
            var knowledgeRefs = request.knowledgeRefs() == null ? List.<KnowledgeRef>of() : request.knowledgeRefs();
            if (new HashSet<>(snapshotIds).size() != snapshotIds.size()
                    || new HashSet<>(knowledgeRefs).size() != knowledgeRefs.size()) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            snapshotIds.forEach(id -> snapshots.findInProject(project, id)
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND")));
            knowledgeRefs.stream().sorted(Comparator.comparing(KnowledgeRef::knowledgeId))
                    .forEach(ref -> knowledge.requireReference(workspace, ref.knowledgeId(), ref.versionId()));

            String title = requireText(request.title());
            String description = requireText(request.description());
            long now = System.currentTimeMillis();
            String id = UUID.randomUUID().toString();
            var task = new TaskSummary(id, project, title, actor, assignee, TaskStatus.TODO.wire, 1, null, now, now);
            tasks.insert(task, description);
            snapshotIds.forEach(snapshotId -> tasks.addSnapshot(id, snapshotId));
            knowledgeRefs.forEach(ref -> tasks.addKnowledge(id, ref));
            tasks.append(id, new TaskTransition("created", actor, null, task.status(), 1, "", "", now));
            publish("task.assigned", actor, workspace, task);
            return encode(new TaskStore.StoredTask(task, description));
        });
    }

    @Transactional(readOnly = true)
    public String list(String actor, String workspace, String project, String assignee, String creator,
                       String status, String afterId, int limit) {
        authorize(actor, workspace, project, false);
        var rows = tasks.list(project, creator == null ? null : actor, assignee == null ? null : actor,
                status == null ? null : TaskStatus.parse(status).code, afterId, limit + 1);
        var page = rows.subList(0, Math.min(rows.size(), limit));
        return contracts.encode("TaskListResponse",
                new TaskListResponse(page, rows.size() > limit ? page.getLast().taskId() : null));
    }

    @Transactional(readOnly = true)
    public String read(String actor, String workspace, String project, String taskId) {
        authorize(actor, workspace, project, false);
        return encode(find(project, taskId));
    }

    @Transactional
    public String patch(String actor, String workspace, String project, String id, String body) {
        authorize(actor, workspace, project, true);
        var request = contracts.decode("TaskPatchRequest", body, TaskPatchRequest.class);
        return write(project, actor, request.requestId(), IdempotentCalls.fingerprint("patch", id, body), () -> {
            var task = requireVersion(project, id, request.expectedVersion());
            var summary = task.summary();
            TaskStatus.requireRole(actor.equals(summary.creatorId()));
            requireState(summary, TaskStatus.TODO);
            return save(actor, workspace, task, "edited", requireText(request.description()), TaskStatus.TODO,
                    summary.conversationId(), "", "");
        });
    }

    @Transactional
    public String transition(String actor, String workspace, String project, String id, String body) {
        authorize(actor, workspace, project, true);
        var request = contracts.decode("TaskTransitionRequest", body, TaskTransitionRequest.class);
        return write(project, actor, request.requestId(), IdempotentCalls.fingerprint("transition", id, body), () -> {
            var task = requireVersion(project, id, request.expectedVersion());
            var summary = task.summary();
            var target = TaskStatus.parse(request.targetStatus());
            TaskStatus.parse(summary.status()).requireTransition(target, actor.equals(summary.creatorId()),
                    actor.equals(summary.assigneeId()));
            if (request.commitSha() != null && target != TaskStatus.REVIEW) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
            return save(actor, workspace, task, "transition", task.description(), target, summary.conversationId(),
                    request.note() == null ? "" : request.note(), request.commitSha() == null ? "" : request.commitSha());
        });
    }

    @Transactional
    public String link(String actor, String workspace, String project, String id, String body) {
        authorize(actor, workspace, project, true);
        var request = contracts.decode("TaskConversationRequest", body, TaskConversationRequest.class);
        return write(project, actor, request.requestId(), IdempotentCalls.fingerprint("link", id, body), () -> {
            var task = requireVersion(project, id, request.expectedVersion());
            var summary = task.summary();
            TaskStatus.requireRole(actor.equals(summary.assigneeId()));
            requireState(summary, TaskStatus.DOING);
            var source = conversations.findById(request.conversationId())
                    .filter(row -> workspace.equals(row.workspaceId()) && project.equals(row.projectId()))
                    .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
            TaskStatus.requireRole(actor.equals(source.ownerUserId()));
            if (summary.conversationId() != null || !tasks.linkConversation(workspace, project, id, source.id(), actor)) {
                throw new ApiProblem(409, "TASK_CONVERSATION_CONFLICT");
            }
            return save(actor, workspace, task, "conversation_linked", task.description(), TaskStatus.DOING,
                    source.id(), "", "");
        });
    }

    private void authorize(String actor, String workspace, String project, boolean writing) {
        var target = policy.requireProject(workspace, project);
        policy.requireActiveMember(project, actor);
        policy.requireWorkspaceMember(workspace, actor);
        if (writing && target.status() == ProjectStatus.ARCHIVED) throw new ApiProblem(409, "PROJECT_ARCHIVED");
    }

    private TaskStore.StoredTask find(String project, String id) {
        return tasks.find(project, id).orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
    }

    private TaskStore.StoredTask requireVersion(String project, String id, long expectedVersion) {
        var task = find(project, id);
        if (task.summary().version() != expectedVersion) throw new ApiProblem(409, "VERSION_CONFLICT");
        return task;
    }

    private String save(String actor, String workspace, TaskStore.StoredTask task, String kind, String description,
                        TaskStatus target, String conversationId, String note, String commitSha) {
        var before = task.summary();
        long now = System.currentTimeMillis();
        if (!tasks.update(before.projectId(), before.taskId(), before.version(), description, target, conversationId, now)) {
            throw new ApiProblem(409, "VERSION_CONFLICT");
        }
        var after = new TaskSummary(before.taskId(), before.projectId(), before.title(), before.creatorId(),
                before.assigneeId(), target.wire, before.version() + 1, conversationId, before.createdAtMs(), now);
        tasks.append(after.taskId(), new TaskTransition(kind, actor, before.status(), target.wire, after.version(),
                note, commitSha, now));
        publish("task.changed", actor, workspace, after);
        return encode(new TaskStore.StoredTask(after, description));
    }

    private void publish(String type, String actor, String workspace, TaskSummary task) {
        notifications.publish(type, task.taskId(), Map.of(
                "workspaceId", workspace, "projectId", task.projectId(), "actorId", actor,
                "creatorId", task.creatorId(), "assigneeId", task.assigneeId()));
    }

    private String encode(TaskStore.StoredTask task) {
        return contracts.encode("TaskDetail", tasks.detail(task));
    }

    private String write(String project, String actor, String requestId, String fingerprint, Supplier<String> action) {
        var receipt = tasks.claim(project, actor, requestId, fingerprint);
        if (!fingerprint.equals(receipt.fingerprint())) throw new ApiProblem(409, "REQUEST_ID_CONFLICT");
        if (!receipt.response().isEmpty()) return receipt.response();
        String response = action.get();
        tasks.remember(project, actor, requestId, response);
        return response;
    }

    private static void requireState(TaskSummary task, TaskStatus expected) {
        if (!expected.wire.equals(task.status())) throw new ApiProblem(409, "TASK_STATE_CONFLICT");
    }

    private static String requireText(String input) {
        if (input.isBlank()) throw new ApiProblem(400, "INVALID_REQUEST");
        return input.strip();
    }
}
