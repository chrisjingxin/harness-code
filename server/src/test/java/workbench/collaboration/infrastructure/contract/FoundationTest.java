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
        return Set.of("wb_user", "wb_user_org", "wb_org", "wb_workspace", "wb_workspace_member", "wb_workspace_request",
                "wb_repository", "wb_project", "wb_project_member", "wb_project_repository",
                "wb_conversation", "wb_conversation_repository", "wb_snapshot",
                "wb_task", "wb_task_transition", "wb_task_link", "wb_task_request",
                "wb_knowledge_item", "wb_knowledge_version", "wb_notification_outbox",
                "wb_user_notification_pref", "wb_external_notification_delivery",
                "wb_knowledge_version_repository", "wb_knowledge_proposal", "wb_knowledge_proposal_event",
                "wb_knowledge_request", "wb_knowledge_read_receipt", "wb_knowledge_usage",
                "wb_knowledge_feedback", "wb_knowledge_review_event");
    }

    private static Set<String> compliantColumns() {
        return Set.of("wb_user.user_id", "wb_user.user_no", "wb_user.user_name",
                "wb_user.org_id", "wb_user.org_name", "wb_user.updated_at",
                "wb_user_org.user_id", "wb_user_org.position_type", "wb_user_org.org_id",
                "wb_user_org.org_no", "wb_user_org.status", "wb_user_org.updated_at",
                "wb_org.org_id", "wb_org.org_no", "wb_org.org_name",
                "wb_org.parent_org_id", "wb_org.path_id", "wb_org.path_name", "wb_org.updated_at",
                "wb_workspace.workspace_id", "wb_workspace.creator_user_id", "wb_workspace.access_version",
                "wb_workspace_member.role", "wb_workspace_member.status", "wb_workspace_member.version", "wb_workspace_member.updated_at", "wb_workspace_member.left_at",
                "wb_workspace_request.workspace_id", "wb_workspace_request.actor_id", "wb_workspace_request.request_id", "wb_workspace_request.fingerprint", "wb_workspace_request.response",
                "wb_repository.repository_id", "wb_repository.remote_url", "wb_repository.remote_url_sha256",
                "wb_repository.status", "wb_repository.owner_user_id", "wb_repository.version", "wb_project.project_id", "wb_project.owner_user_id", "wb_project.version",
                "wb_conversation.conversation_id", "wb_conversation.project_id", "wb_conversation.owner_user_id",
                "wb_conversation.status", "wb_conversation.brief_source", "wb_conversation.brief_updated_at",
                "wb_conversation.synced_sequence", "wb_conversation.share_mode", "wb_conversation.share_status",
                "wb_conversation.stopped_at",
                "wb_conversation_repository.conversation_id", "wb_conversation_repository.repository_id",
                "wb_snapshot.snapshot_id", "wb_snapshot.project_id", "wb_snapshot.source_conversation_id",
                "wb_snapshot.source_owner_user_id", "wb_snapshot.source_title", "wb_snapshot.source_synced_sequence",
                "wb_snapshot.source_synced_at", "wb_snapshot.from_sequence", "wb_snapshot.to_sequence",
                "wb_snapshot.message_count", "wb_snapshot.text", "wb_snapshot.sha256", "wb_snapshot.storage_uri",
                "wb_snapshot.created_by_user_id", "wb_snapshot.created_at",
                "wb_task.task_id", "wb_task.project_id", "wb_task.assignee_id", "wb_task.status", "wb_task.version", "wb_task.conversation_id",
                "wb_task_transition.task_id", "wb_task_transition.version", "wb_task_transition.actor_id",
                "wb_task_transition.from_status", "wb_task_transition.to_status", "wb_task_transition.commit_sha", "wb_task_transition.from_assignee_id", "wb_task_transition.to_assignee_id", "wb_task_transition.previous_conversation_id",
                "wb_task_link.task_id", "wb_task_link.link_type", "wb_task_link.version_id", "wb_task_link.knowledge_id",
                "wb_task_request.project_id", "wb_task_request.actor_id", "wb_task_request.request_id", "wb_task_request.fingerprint", "wb_task_request.response",
                "wb_knowledge_item.workspace_id", "wb_knowledge_item.knowledge_id", "wb_knowledge_item.term_key",
                "wb_knowledge_item.current_version_id", "wb_knowledge_item.version", "wb_knowledge_item.indexed_version", "wb_knowledge_item.archived",
                "wb_knowledge_item.last_reviewed_at", "wb_knowledge_item.reviewed_feedback_id",
                "wb_knowledge_version.knowledge_id", "wb_knowledge_version.version_id", "wb_knowledge_version.version", "wb_knowledge_version.text",
                "wb_knowledge_version.level", "wb_knowledge_version.scope_kind", "wb_knowledge_version.content_type",
                "wb_knowledge_version.contributors", "wb_knowledge_version.proposal_id", "wb_knowledge_version.reviewer_id", "wb_knowledge_version.reviewed_at",
                "wb_knowledge_version_repository.version_id", "wb_knowledge_version_repository.repository_id",
                "wb_knowledge_proposal.proposal_id", "wb_knowledge_proposal.workspace_id", "wb_knowledge_proposal.proposer_id",
                "wb_knowledge_proposal.proposer_member_version", "wb_knowledge_proposal.content", "wb_knowledge_proposal.revision",
                "wb_knowledge_proposal.status", "wb_knowledge_proposal.submitted_at",
                "wb_knowledge_proposal_event.proposal_id", "wb_knowledge_proposal_event.content",
                "wb_knowledge_proposal_event.actor_id", "wb_knowledge_proposal_event.kind",
                "wb_knowledge_request.workspace_id", "wb_knowledge_request.actor_id", "wb_knowledge_request.request_id",
                "wb_knowledge_request.fingerprint", "wb_knowledge_request.response",
                "wb_knowledge_read_receipt.read_id", "wb_knowledge_read_receipt.knowledge_id", "wb_knowledge_read_receipt.version_id",
                "wb_knowledge_usage.knowledge_id", "wb_knowledge_usage.version_id", "wb_knowledge_usage.read_count",
                "wb_knowledge_feedback.knowledge_id", "wb_knowledge_feedback.version_id", "wb_knowledge_feedback.user_id",
                "wb_knowledge_feedback.value", "wb_knowledge_feedback.event_id",
                "wb_knowledge_review_event.knowledge_id", "wb_knowledge_review_event.version_id", "wb_knowledge_review_event.actor_id",
                "wb_knowledge_review_event.kind", "wb_knowledge_review_event.note",
                "wb_notification_outbox.workspace_id", "wb_notification_outbox.user_id", "wb_notification_outbox.project_id",
                "wb_notification_outbox.event_id", "wb_notification_outbox.event_type", "wb_notification_outbox.object_id",
                "wb_user_notification_pref.user_id", "wb_user_notification_pref.external_enabled", "wb_user_notification_pref.subscribed_events",
                "wb_user_notification_pref.dnd_enabled", "wb_user_notification_pref.dnd_start_minute", "wb_user_notification_pref.dnd_end_minute",
                "wb_user_notification_pref.dnd_timezone", "wb_user_notification_pref.merge_window_sec", "wb_user_notification_pref.version",
                "wb_user_notification_pref.created_at", "wb_user_notification_pref.updated_at",
                "wb_external_notification_delivery.delivery_id", "wb_external_notification_delivery.user_id",
                "wb_external_notification_delivery.workspace_id", "wb_external_notification_delivery.project_id",
                "wb_external_notification_delivery.event_type", "wb_external_notification_delivery.object_id",
                "wb_external_notification_delivery.actor_id", "wb_external_notification_delivery.urgency",
                "wb_external_notification_delivery.title_snapshot", "wb_external_notification_delivery.merge_key",
                "wb_external_notification_delivery.status", "wb_external_notification_delivery.skip_reason",
                "wb_external_notification_delivery.attempt_count", "wb_external_notification_delivery.max_attempts",
                "wb_external_notification_delivery.available_at", "wb_external_notification_delivery.last_error",
                "wb_external_notification_delivery.occurred_at", "wb_external_notification_delivery.created_at",
                "wb_external_notification_delivery.updated_at");
    }

    @Test
    void 空库列出全部缺失表并拒绝启动() {
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> foundation(Set.of(), Set.of()).validate());
        assertTrue(error.getMessage().contains("30"));
    }

    @Test
    void 合规结构通过核对() {
        assertDoesNotThrow(() -> foundation(compliantTables(), compliantColumns()).validate());
    }

    @Test
    void 探测到旧协作表拒绝启动() {
        Set<String> tables = new HashSet<>(compliantTables());
        tables.add("wb_device");
        tables.add("wb_local_repo_binding");
        tables.add("wb_device_project");
        tables.add("wb_message");
        assertThrows(IllegalStateException.class,
                () -> foundation(tables, compliantColumns()).validate());
    }

    @Test
    void 探测到旧语义列拒绝启动() {
        Set<String> columns = new HashSet<>(compliantColumns());
        columns.add("wb_conversation.device_id");
        columns.add("wb_conversation.next_sequence");
        assertThrows(IllegalStateException.class,
                () -> foundation(compliantTables(), columns).validate());
    }
}
