package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import workbench.collaboration.interfaces.ApiProblem;
import javax.sql.DataSource;
import java.util.List;
import java.util.Optional;

/**
 * 团队管理持久化：上游管理服务已先锁团队行，所有职责写入与回执共用事务。
 * 读取完整清单 → 服务层验证版本/接手人 → 更新职责与资格 → 保存回执；不触碰消息正文或 Agent。
 */
@Repository
public class WorkspaceStore {
    private final JdbcTemplate jdbc;
    public WorkspaceStore(DataSource source) { jdbc=new JdbcTemplate(source); }
    public record WorkTask(String id, String project, String title, int status, long version,
            String creator, String assignee, String conversation, boolean archived) {}
    public record WorkProject(String id, String name, int status, long version, String owner, boolean targetIsMember) {}
    public record WorkRepository(String id, String name, int status, long version, String owner) {}
    public record Receipt(String fingerprint, String response) {}

    public int adminCount(String workspace) {
        return jdbc.queryForObject("""
            SELECT COUNT(*) FROM wb_workspace_member m JOIN wb_user u ON u.user_id=m.user_id
            WHERE m.workspace_id=? AND m.status=1 AND m.role=1 AND u.enabled=1
            """, Integer.class, workspace);
    }
    public void bump(String workspace) { jdbc.update("UPDATE wb_workspace SET access_version=access_version+1 WHERE workspace_id=?",workspace); }
    public void role(String workspace, String user, int role) {
        jdbc.update("UPDATE wb_workspace_member SET role=?,version=version+1,updated_at=? WHERE workspace_id=? AND user_id=?",role,Times.ofMs(System.currentTimeMillis()),workspace,user);
    }
    public void rejoin(String workspace,String user) {
        var now=Times.ofMs(System.currentTimeMillis());
        jdbc.update("UPDATE wb_workspace_member SET status=1,role=2,version=version+1,updated_at=?,left_at=created_at WHERE workspace_id=? AND user_id=?",now,workspace,user);
    }
    public int memberCount(String workspace) { return jdbc.queryForObject("SELECT COUNT(*) FROM wb_workspace_member WHERE workspace_id=?",Integer.class,workspace); }
    public Optional<Receipt> receipt(String workspace,String actor,String request) {
        return jdbc.query("SELECT fingerprint,response FROM wb_workspace_request WHERE workspace_id=? AND actor_id=? AND request_id=?",
                (r,n)->new Receipt(r.getString(1),r.getString(2)),workspace,actor,request).stream().findFirst();
    }
    public void remember(String workspace,String actor,String request,String action,String target,String fingerprint,String summary,String response) {
        jdbc.update("""
            INSERT INTO wb_workspace_request(workspace_id,actor_id,request_id,action,target_user_id,fingerprint,change_summary,response,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)
            """,workspace,actor,request,action,target,fingerprint,summary,response,Times.ofMs(System.currentTimeMillis()));
    }
    public List<WorkTask> tasks(String workspace,String target) {
        return jdbc.query("""
            SELECT t.*,p.status project_status FROM wb_task t JOIN wb_project p ON p.project_id=t.project_id
            WHERE p.workspace_id=? AND t.status IN(1,2,3) AND (t.assignee_id=? OR t.creator_id=?) ORDER BY t.task_id
            """,(r,n)->new WorkTask(r.getString("task_id"),r.getString("project_id"),r.getString("title"),r.getInt("status"),r.getLong("version"),
                r.getString("creator_id"),r.getString("assignee_id"),r.getString("conversation_id"),r.getInt("project_status")==2),workspace,target,target);
    }
    public List<WorkProject> projects(String workspace,String target) {
        return jdbc.query("""
            SELECT p.*,EXISTS(SELECT 1 FROM wb_project_member m WHERE m.project_id=p.project_id AND m.user_id=? AND m.status=1) target_member
            FROM wb_project p WHERE p.workspace_id=? AND (p.owner_user_id=?
              OR EXISTS(SELECT 1 FROM wb_project_member m WHERE m.project_id=p.project_id AND m.user_id=? AND m.status=1)
              OR EXISTS(SELECT 1 FROM wb_task t WHERE t.project_id=p.project_id AND t.status IN(1,2,3) AND (t.creator_id=? OR t.assignee_id=?)))
            ORDER BY p.project_id
            """,(r,n)->new WorkProject(r.getString("project_id"),r.getString("name"),r.getInt("status"),r.getLong("version"),r.getString("owner_user_id"),r.getBoolean("target_member")),target,workspace,target,target,target,target);
    }
    public List<WorkRepository> repositories(String workspace,String target) {
        return jdbc.query("SELECT * FROM wb_repository WHERE workspace_id=? AND owner_user_id=? ORDER BY repository_id",
                (r,n)->new WorkRepository(r.getString("repository_id"),r.getString("name"),r.getInt("status"),r.getLong("version"),r.getString("owner_user_id")),workspace,target);
    }
    public List<String> projectMembers(String workspace,String project,String target) {
        return jdbc.queryForList("""
            SELECT p.user_id FROM wb_project_member p JOIN wb_workspace_member m ON m.user_id=p.user_id AND m.workspace_id=?
            JOIN wb_user u ON u.user_id=m.user_id WHERE p.project_id=? AND p.status=1 AND m.status=1 AND u.enabled=1 AND p.user_id<>? ORDER BY p.user_id
            """,String.class,workspace,project,target);
    }
    public int sharedCount(String workspace,String target) { return jdbc.queryForObject("SELECT COUNT(*) FROM wb_conversation WHERE workspace_id=? AND owner_user_id=?",Integer.class,workspace,target); }
    public void addProjectMember(String project,String user) {
        var now=Times.ofMs(System.currentTimeMillis());
        jdbc.update("""
            INSERT INTO wb_project_member(project_id,user_id,status,created_at,updated_at) VALUES(?,?,1,?,?)
            ON DUPLICATE KEY UPDATE status=1,updated_at=VALUES(updated_at)
            """,project,user,now,now);
    }
    public void transferProject(WorkProject project,String user) {
        changed(jdbc.update("UPDATE wb_project SET owner_user_id=?,version=version+1,updated_at=? WHERE project_id=? AND version=?",
                user,Times.ofMs(System.currentTimeMillis()),project.id(),project.version()));
    }
    public void transferTask(WorkTask task,String actor,String user) {
        var now=Times.ofMs(System.currentTimeMillis());
        changed(jdbc.update("UPDATE wb_task SET assignee_id=?,status=1,conversation_id='',version=version+1,updated_at=? WHERE task_id=? AND version=?",user,now,task.id(),task.version()));
        jdbc.update("""
            INSERT INTO wb_task_transition(task_id,version,kind,actor_id,from_status,to_status,note,commit_sha,created_at,
              from_assignee_id,to_assignee_id,previous_conversation_id) VALUES(?,?,'reassigned',?,?,1,'成员离开团队，工作转交后待接收','',?,?,?,?)
            """,task.id(),task.version()+1,actor,task.status(),now,task.assignee(),user,task.conversation());
    }
    public void transferRepository(WorkRepository repository,String user) {
        changed(jdbc.update("UPDATE wb_repository SET owner_user_id=?,version=version+1,updated_at=? WHERE repository_id=? AND version=?",
                user==null?"":user,Times.ofMs(System.currentTimeMillis()),repository.id(),repository.version()));
    }
    /** 只停止云端同步，不改 owner/消息/序号；Project 行留 removed 供历史展示。 */
    public int remove(String workspace,String target) {
        var now=Times.ofMs(System.currentTimeMillis());
        int stopped=jdbc.update("UPDATE wb_conversation SET share_status=2,stopped_at=?,updated_at=? WHERE workspace_id=? AND owner_user_id=? AND share_status=1",now,now,workspace,target);
        jdbc.update("""
            UPDATE wb_project_member m JOIN wb_project p ON p.project_id=m.project_id SET m.status=2,m.updated_at=?
            WHERE p.workspace_id=? AND m.user_id=? AND m.status=1
            """,now,workspace,target);
        jdbc.update("UPDATE wb_workspace_member SET status=2,version=version+1,updated_at=?,left_at=? WHERE workspace_id=? AND user_id=?",now,now,workspace,target);
        bump(workspace);
        return stopped;
    }
    private static void changed(int rows) { if(rows!=1) throw new ApiProblem(409,"VERSION_CONFLICT"); }
}
