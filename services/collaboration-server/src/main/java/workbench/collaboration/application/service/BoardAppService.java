package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.device.DeviceHeartbeatPort;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.ProjectPresenceStore;
import workbench.collaboration.infrastructure.persistence.TaskStore;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static workbench.collaboration.interfaces.dto.BoardDtos.*;
import static workbench.collaboration.interfaces.dto.TaskDtos.TaskSummary;

/** 复用已同步简报、任务摘要与设备心跳，组装项目成员可读的看板。 */
@Service
public class BoardAppService {
    private static final int LIMIT = 100;
    private final ProjectAccessPolicy policy;
    private final ProjectRepository projects;
    private final IdentityRepository identity;
    private final ConversationRepository conversations;
    private final ConversationAppService briefs;
    private final TaskStore tasks;
    private final ProjectPresenceStore presence;
    private final DeviceHeartbeatPort heartbeats;
    private final Contracts contracts;

    public BoardAppService(ProjectAccessPolicy policy, ProjectRepository projects, IdentityRepository identity,
                           ConversationRepository conversations, ConversationAppService briefs, TaskStore tasks,
                           ProjectPresenceStore presence, DeviceHeartbeatPort heartbeats, Contracts contracts) {
        this.policy = policy;
        this.projects = projects;
        this.identity = identity;
        this.conversations = conversations;
        this.briefs = briefs;
        this.tasks = tasks;
        this.presence = presence;
        this.heartbeats = heartbeats;
        this.contracts = contracts;
    }

    @Transactional(readOnly = true)
    public String read(String actor, String workspace, String project) {
        policy.requireProject(workspace, project);
        policy.requireActiveMember(project, actor);
        policy.requireWorkspaceMember(workspace, actor);
        var users = identity.listMembers(workspace).stream().collect(Collectors.toMap(User::id, User::userName));
        var online = presence.devices(workspace, project).stream()
                .filter(device -> heartbeats.isOnline(device.deviceId())).toList();
        var onlineDevices = online.stream().map(ProjectPresenceStore.ProjectDevice::deviceId).collect(Collectors.toSet());
        var onlineUsers = online.stream().map(ProjectPresenceStore.ProjectDevice::ownerId).collect(Collectors.toSet());
        var recent = conversations.listByProject(project, null, null, LIMIT + 1);
        var active = tasks.active(project, LIMIT + 1);
        var visibleConversations = recent.stream().limit(LIMIT)
                .map(row -> new BoardConversation(briefs.summary(row), onlineDevices.contains(row.deviceId()))).toList();
        var visibleTasks = active.stream().limit(LIMIT).toList();
        var conversationsByOwner = groups(visibleConversations, row -> row.conversation().ownerUserId(),
                row -> row.conversation().conversationId());
        var received = groups(visibleTasks, TaskSummary::assigneeId, TaskSummary::taskId);
        var sent = groups(visibleTasks, TaskSummary::creatorId, TaskSummary::taskId);
        var members = projects.listMembers(project).stream().map(member -> {
            String id = member.userId();
            return new BoardMember(id, users.getOrDefault(id, ""), member.status().code(), onlineUsers.contains(id),
                    conversationsByOwner.getOrDefault(id, List.of()), received.getOrDefault(id, List.of()),
                    sent.getOrDefault(id, List.of()));
        }).toList();
        return contracts.encode("BoardResponse",
                new BoardResponse(project, members, visibleConversations, visibleTasks,
                        recent.size() > LIMIT, active.size() > LIMIT));
    }

    private static <T> Map<String, List<String>> groups(List<T> rows, Function<T, String> owner,
                                                       Function<T, String> id) {
        return rows.stream().collect(Collectors.groupingBy(owner, Collectors.mapping(id, Collectors.toList())));
    }
}
