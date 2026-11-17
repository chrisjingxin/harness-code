package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.snapshot.ConversationSnapshot;
import workbench.collaboration.domain.snapshot.SnapshotRepository;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.Digests;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.SnapshotDtos;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

/**
 * 为项目成员从已确认同步的消息或简报生成不可变快照。
 * REST 请求 → 项目及来源校验 → 按会话头的确认序号取材 → 校验字节并写入整份快照。
 * 读取时重新校验成员资格，随后仅访问快照表。
 */
@Service
public class SnapshotAppService {
    private static final int DEFAULT_COUNT = 20;
    private static final int HISTORY_PAGE_SIZE = 20;
    private static final int MAX_TEXT_BYTES = 64 * 1024;

    private final ProjectAccessPolicy policy;
    private final ConversationRepository conversations;
    private final MessageStorePort messages;
    private final SnapshotRepository snapshots;
    private final Contracts contracts;
    private final NotificationPort notifications;

    public SnapshotAppService(
            ProjectAccessPolicy policy, ConversationRepository conversations, MessageStorePort messages,
            SnapshotRepository snapshots, Contracts contracts, NotificationPort notifications
    ) {
        this.policy = policy;
        this.conversations = conversations;
        this.messages = messages;
        this.snapshots = snapshots;
        this.contracts = contracts;
        this.notifications = notifications;
    }

    /** 校验来源和范围，保存完整正文。空材料或超预算时不分配可读取的快照。 */
    @Transactional
    public String create(String userId, String workspaceId, String projectId, String rawBody) {
        var project = policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        if (project.status() == ProjectStatus.ARCHIVED) {
            throw new ApiProblem(409, "PROJECT_ARCHIVED");
        }
        var request = contracts.decode("SnapshotCreateRequest", rawBody, SnapshotDtos.SnapshotCreateRequest.class);
        var source = conversations.findById(request.sourceConversationId())
                .filter(conversation -> workspaceId.equals(conversation.workspaceId())
                        && projectId.equals(conversation.projectId()))
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));

        var range = request.range();
        boolean brief = range != null && "brief".equals(range.type());
        var material = brief ? fromBrief(source) : fromMessages(source, range);
        var snapshot = new ConversationSnapshot(
                UUID.randomUUID().toString(), projectId, source.id(), source.ownerUserId(),
                source.title(), source.syncedSequence(), brief ? source.briefUpdatedAtMs() : source.updatedAtMs(),
                material.from(), material.to(), material.count(), material.text(), Digests.sha256Hex(material.text()),
                userId, System.currentTimeMillis());
        snapshots.insert(snapshot);
        notifications.publish("snapshot.created", snapshot.snapshotId(), Map.of(
                "workspaceId", workspaceId, "actorId", userId, "projectId", projectId));
        return encode(snapshot);
    }

    /** 按当前项目读权限返回原始快照。项目归档后仍可读。 */
    @Transactional(readOnly = true)
    public String read(String userId, String workspaceId, String projectId, String snapshotId) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        return encode(snapshots.findInProject(projectId, snapshotId)
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND")));
    }

    private static Material fromBrief(Conversation source) {
        String text = source.briefText();
        if (text.isBlank()) {
            throw new ApiProblem(409, "SNAPSHOT_EMPTY");
        }
        requireFits(utf8Bytes(text));
        return new Material(0, 0, 0, text);
    }

    private Material fromMessages(Conversation source, SnapshotDtos.RequestedRange range) {
        long watermark = source.syncedSequence();
        long from;
        long to;
        if (range == null || "latest".equals(range.type())) {
            if (watermark == 0) {
                throw new ApiProblem(409, "SNAPSHOT_EMPTY");
            }
            int count = range == null || range.count() == null ? DEFAULT_COUNT : range.count();
            to = watermark;
            from = Math.max(1, to - count + 1);
        } else {
            from = range.fromSequence() == null ? 1 : range.fromSequence();
            to = range.toSequence();
            if (from > to || to > watermark) {
                throw new ApiProblem(400, "INVALID_REQUEST");
            }
        }

        StringBuilder text = new StringBuilder();
        int bytes = 0;
        int count = 0;
        long cursor = from - 1;
        while (cursor < to) {
            int limit = (int) Math.min(HISTORY_PAGE_SIZE, to - cursor);
            var page = messages.after(source.workspaceId(), source.id(), cursor, limit);
            if (page.size() != limit) {
                throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
            }
            for (var message : page) {
                // 热窗可能比已提交的会话头更新。任何缺段或错序都拒绝生成快照。
                if (message.sequence() != cursor + 1 || !source.id().equals(message.conversationId())
                        || !source.workspaceId().equals(message.workspaceId())) {
                    throw new ApiProblem(503, "SERVICE_UNAVAILABLE");
                }
                String entry = (count == 0 ? "" : "\n\n") + "[" + message.sequence() + " " + message.type() + "]\n"
                        + message.payload();
                bytes += utf8Bytes(entry);
                requireFits(bytes);
                text.append(entry);
                cursor = message.sequence();
                count++;
            }
        }
        return new Material(from, to, count, text.toString());
    }

    private String encode(ConversationSnapshot snapshot) {
        return contracts.encode("SnapshotResponse", SnapshotDtos.SnapshotResponse.from(snapshot));
    }

    private static int utf8Bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8).length;
    }

    private static void requireFits(int bytes) {
        if (bytes > MAX_TEXT_BYTES) {
            throw new ApiProblem(413, "SNAPSHOT_TOO_LARGE");
        }
    }

    private record Material(long from, long to, int count, String text) {}
}
