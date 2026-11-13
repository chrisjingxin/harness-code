package workbench.collaboration.infrastructure.contract;

import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Foundation 启动期只读核对：空库报全量缺失、合规库放行、旧表/旧列残留拒绝启动。
 * 用 JdbcTemplate 替身模拟 information_schema 查询结果，不依赖真实数据库。
 */
class FoundationTest {

    private static Foundation foundation(Set<String> tables, Set<String> columns) {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        // 两参变长参数（表 + 列）：information_schema.columns 精确列核对
        when(jdbc.queryForObject(anyString(), any(Class.class), anyString(), anyString()))
                .thenAnswer(invocation -> columns.contains(invocation.getArgument(2) + "." + invocation.getArgument(3)) ? 1 : 0);
        // 单参变长参数（表）：表存在性/引擎/字符集 与 id 主键核对
        when(jdbc.queryForObject(anyString(), any(Class.class), anyString()))
                .thenAnswer(invocation -> tables.contains(invocation.getArgument(2, String.class)) ? 1 : 0);
        return new Foundation(jdbc, null, null);
    }

    private static Set<String> compliantTables() {
        return Set.of("wb_user", "wb_user_org", "wb_org", "wb_workspace", "wb_workspace_member", "wb_device",
                "wb_repository", "wb_project", "wb_project_member", "wb_project_repository",
                "wb_local_repo_binding", "wb_conversation", "wb_conversation_repository");
    }

    private static Set<String> compliantColumns() {
        return Set.of("wb_user.user_id", "wb_user.user_no", "wb_user.user_name",
                "wb_user.org_id", "wb_user.org_name", "wb_user.updated_at",
                "wb_user_org.user_id", "wb_user_org.position_type", "wb_user_org.org_id",
                "wb_user_org.org_no", "wb_user_org.status", "wb_user_org.updated_at",
                "wb_org.org_id", "wb_org.org_no", "wb_org.org_name",
                "wb_org.parent_org_id", "wb_org.path_id", "wb_org.path_name", "wb_org.updated_at",
                "wb_workspace.workspace_id",
                "wb_device.device_id", "wb_device.owner_user_id",
                "wb_repository.repository_id", "wb_repository.remote_url", "wb_repository.remote_url_sha256",
                "wb_repository.status", "wb_project.project_id", "wb_project.owner_user_id", "wb_project.version",
                "wb_conversation.conversation_id", "wb_conversation.project_id", "wb_conversation.owner_user_id",
                "wb_conversation.status", "wb_conversation.brief_source", "wb_conversation.brief_updated_at",
                "wb_conversation.synced_sequence",
                "wb_local_repo_binding.device_id", "wb_local_repo_binding.repository_id",
                "wb_conversation_repository.conversation_id", "wb_conversation_repository.repository_id");
    }

    @Test
    void 空库列出全部缺失表并拒绝启动() {
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> foundation(Set.of(), Set.of()).validate());
        assertTrue(error.getMessage().contains("13"));
    }

    @Test
    void 合规结构通过核对() {
        assertDoesNotThrow(() -> foundation(compliantTables(), compliantColumns()).validate());
    }

    @Test
    void 探测到旧协作表拒绝启动() {
        Set<String> tables = new HashSet<>(compliantTables());
        tables.add("wb_device_project");
        tables.add("wb_message");
        assertThrows(IllegalStateException.class,
                () -> foundation(tables, compliantColumns()).validate());
    }

    @Test
    void 探测到旧语义列拒绝启动() {
        Set<String> columns = new HashSet<>(compliantColumns());
        columns.add("wb_device.workspace_id");
        columns.add("wb_conversation.next_sequence");
        assertThrows(IllegalStateException.class,
                () -> foundation(compliantTables(), columns).validate());
    }
}
