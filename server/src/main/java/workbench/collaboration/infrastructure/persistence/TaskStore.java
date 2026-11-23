package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.task.TaskStatus;
import workbench.collaboration.interfaces.dto.TaskDtos;

import javax.sql.DataSource;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static workbench.collaboration.interfaces.dto.TaskDtos.*;

/**
 * 任务、固定材料、审计与写请求回执使用同一个数据源及事务。
 * 版本条件保护业务行；回执行只序列化同项目、同用户和同编号的请求。
 */
@Repository
public class TaskStore {
    private static final RowMapper<TaskSummary> SUMMARY = (row, index) -> new TaskSummary(
            row.getString("task_id"), row.getString("project_id"), row.getString("title"),
            row.getString("creator_id"), row.getString("assignee_id"), TaskStatus.fromCode(row.getInt("status")).wire,
            row.getLong("version"), emptyToNull(row.getString("conversation_id")),
            Times.ms(row.getObject("created_at", LocalDateTime.class)),
            Times.ms(row.getObject("updated_at", LocalDateTime.class)));
    private final JdbcTemplate jdbc;

    public TaskStore(DataSource dataSource) {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    public record StoredTask(TaskSummary summary, String description) {}
    public record Receipt(String fingerprint, String response) {}

    public Optional<StoredTask> find(String projectId, String taskId) {
        return jdbc.query("SELECT * FROM wb_task WHERE project_id=? AND task_id=?",
                (row, index) -> new StoredTask(SUMMARY.mapRow(row, index), row.getString("description")),
                projectId, taskId).stream().findFirst();
    }

    /** 按业务 ID 翻页。传 null 可不限定角色和状态。 */
    public List<TaskSummary> list(String projectId, String creator, String assignee, Integer status,
                                  String afterId, int limit) {
        return jdbc.query("""
                SELECT * FROM wb_task WHERE project_id=? AND task_id>?
                  AND (? IS NULL OR creator_id=?) AND (? IS NULL OR assignee_id=?)
                  AND (? IS NULL OR status=?) ORDER BY task_id LIMIT ?
                """, SUMMARY, projectId, afterId, creator, creator, assignee, assignee, status, status, limit);
    }

    public List<TaskSummary> active(String projectId, int limit) {
        return jdbc.query("""
                SELECT * FROM wb_task WHERE project_id=? AND status IN (1,2,3)
                ORDER BY updated_at DESC, task_id LIMIT ?
                """, SUMMARY, projectId, limit);
    }

    public void insert(TaskSummary task, String description) {
        jdbc.update("""
                INSERT INTO wb_task (task_id, project_id, title, description, creator_id, assignee_id,
                                     status, version, created_at, updated_at)
                VALUES (?,?,?,?,?,?,1,1,?,?)
                """, task.taskId(), task.projectId(), task.title(), description, task.creatorId(), task.assigneeId(),
                Times.ofMs(task.createdAtMs()), Times.ofMs(task.updatedAtMs()));
    }

    public boolean update(String projectId, String taskId, long expectedVersion, String description,
                          TaskStatus status, String conversationId, long now) {
        return jdbc.update("""
                UPDATE wb_task SET description=?, status=?, conversation_id=?, version=version+1, updated_at=?
                WHERE project_id=? AND task_id=? AND version=?
                """, description, status.code, conversationId == null ? "" : conversationId, Times.ofMs(now),
                projectId, taskId, expectedVersion) == 1;
    }

    /** 写会话反向关系时条件检查归属和空槽，防止并发把同一会话分给两个任务。 */
    public boolean linkConversation(String workspaceId, String projectId, String taskId, String conversationId,
                                    String ownerUserId) {
        return jdbc.update("""
                UPDATE wb_conversation SET task_id=? WHERE workspace_id=? AND project_id=?
                      AND conversation_id=? AND owner_user_id=? AND task_id=''
                """, taskId, workspaceId, projectId, conversationId, ownerUserId) == 1;
    }

    public void addSnapshot(String taskId, String snapshotId) {
        link(taskId, 1, snapshotId, "");
    }

    public void addKnowledge(String taskId, TaskDtos.KnowledgeRef ref) {
        link(taskId, 2, ref.versionId(), ref.knowledgeId());
    }

    private void link(String taskId, int type, String versionId, String knowledgeId) {
        jdbc.update("INSERT INTO wb_task_link (task_id, link_type, version_id, knowledge_id) VALUES (?,?,?,?)",
                taskId, type, versionId, knowledgeId);
    }

    public void append(String taskId, TaskTransition change) {
        jdbc.update("""
                INSERT INTO wb_task_transition (task_id, version, kind, actor_id, from_status, to_status,
                                               note, commit_sha, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """, taskId, change.version(), change.kind(), change.actorId(),
                change.fromStatus() == null ? 0 : TaskStatus.parse(change.fromStatus()).code,
                TaskStatus.parse(change.toStatus()).code, change.note(), change.commitSha(),
                Times.ofMs(change.occurredAtMs()));
    }

    public TaskDetail detail(StoredTask task) {
        String id = task.summary().taskId();
        var snapshots = jdbc.queryForList("""
                SELECT version_id FROM wb_task_link WHERE task_id=? AND link_type=1 ORDER BY id
                """, String.class, id);
        var knowledge = jdbc.query("""
                SELECT knowledge_id, version_id FROM wb_task_link WHERE task_id=? AND link_type=2 ORDER BY id
                """, (row, index) -> new KnowledgeRef(row.getString(1), row.getString(2)), id);
        var transitions = jdbc.query("""
                SELECT * FROM wb_task_transition WHERE task_id=? ORDER BY version
                """, (row, index) -> new TaskTransition(
                row.getString("kind"), row.getString("actor_id"),
                row.getInt("from_status") == 0 ? null : TaskStatus.fromCode(row.getInt("from_status")).wire,
                TaskStatus.fromCode(row.getInt("to_status")).wire, row.getLong("version"),
                row.getString("note"), row.getString("commit_sha"),
                Times.ms(row.getObject("created_at", LocalDateTime.class)),
                "reassigned".equals(row.getString("kind")) ? new TaskHandoff(row.getString("from_assignee_id"),row.getString("to_assignee_id"),emptyToNull(row.getString("previous_conversation_id"))) : null), id);
        return new TaskDetail(task.summary(), task.description(), snapshots, knowledge, transitions);
    }

    public Receipt claim(String projectId, String userId, String requestId, String fingerprint) {
        // 请求首次写入和业务共用事务。回滚时占位也回滚，重试不会卡在半完成状态。
        jdbc.update("""
                INSERT INTO wb_task_request (project_id, actor_id, request_id, fingerprint, response)
                VALUES (?,?,?,?, '') ON DUPLICATE KEY UPDATE request_id=wb_task_request.request_id
                """, projectId, userId, requestId, fingerprint);
        return jdbc.queryForObject("""
                SELECT fingerprint, response FROM wb_task_request
                WHERE project_id=? AND actor_id=? AND request_id=? FOR UPDATE
                """, (row, index) -> new Receipt(row.getString(1), row.getString(2)), projectId, userId, requestId);
    }

    public void remember(String projectId, String userId, String requestId, String response) {
        jdbc.update("UPDATE wb_task_request SET response=? WHERE project_id=? AND actor_id=? AND request_id=?",
                response, projectId, userId, requestId);
    }

    private static String emptyToNull(String value) {
        return value.isEmpty() ? null : value;
    }
}
