package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.NotificationStore;
import workbench.collaboration.interfaces.dto.NotificationDtos.NotificationEvent;
import workbench.collaboration.interfaces.dto.NotificationDtos.NotificationPage;

/** 用户通知分页和 SSE 的共用读取规则。每批重新确认当前团队成员。 */
@Service
public class NotificationAppService {
    private final ProjectAccessPolicy policy;
    private final NotificationStore store;
    private final Contracts contracts;

    public NotificationAppService(ProjectAccessPolicy policy, NotificationStore store, Contracts contracts) {
        this.policy = policy;
        this.store = store;
        this.contracts = contracts;
    }

    public void requireMember(String workspace, String user) {
        policy.requireWorkspaceMember(workspace, user);
    }

    @Transactional(readOnly = true)
    public NotificationPage page(String workspace, String user, long cursor, int limit) {
        requireMember(workspace, user);
        var rows = store.after(workspace, user, cursor, limit + 1);
        var events = rows.subList(0, Math.min(limit, rows.size()));
        return new NotificationPage(events, events.isEmpty() ? cursor : events.getLast().id(), rows.size() > limit);
    }

    public String encodePage(NotificationPage page) {
        return contracts.encode("NotificationPage", page);
    }

    public String encodeEvent(NotificationEvent event) {
        return contracts.encode("NotificationEvent", event);
    }
}
