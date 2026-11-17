package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import javax.sql.DataSource;
import java.util.List;

/** 只读取项目在册成员的有效设备标识，供看板查询心跳。 */
@Repository
public class ProjectPresenceStore {
    private final JdbcTemplate jdbc;

    public ProjectPresenceStore(DataSource source) {
        this.jdbc = new JdbcTemplate(source);
    }

    public record ProjectDevice(String ownerId, String deviceId) {}

    public List<ProjectDevice> devices(String workspace, String project) {
        return jdbc.query("""
                SELECT d.owner_user_id, d.device_id FROM wb_device d
                JOIN wb_project_member p ON p.user_id=d.owner_user_id AND p.project_id=? AND p.status=1
                JOIN wb_workspace_member w ON w.user_id=d.owner_user_id AND w.workspace_id=?
                JOIN wb_user u ON u.user_id=d.owner_user_id AND u.enabled=1
                WHERE d.revoked=0
                """, (row, index) -> new ProjectDevice(row.getString(1), row.getString(2)), project, workspace);
    }
}
