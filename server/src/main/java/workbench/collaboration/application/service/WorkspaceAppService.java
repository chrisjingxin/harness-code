package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.identity.*;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.infrastructure.persistence.WorkspaceStore;
import workbench.collaboration.infrastructure.persistence.WorkspaceStore.*;
import workbench.collaboration.infrastructure.contract.*;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.WorkspaceDtos.*;
import java.util.*;
import java.util.function.Supplier;
import tools.jackson.databind.json.JsonMapper;

/**
 * 团队管理入口：真实权限 → 团队锁 → 完整责任重读 → 一次交接与移除。
 * 上游 REST/桌面只提交选择；下游身份仓储与 WorkspaceStore 共用事务。
 * 通知仅在提交后唤醒，不传正文、不调用模型、不转移 Agent 执行权。
 */
@Service
public class WorkspaceAppService {
    private final IdentityRepository identity;
    private final IdentityAppService views;
    private final ProjectAccessPolicy policy;
    private final WorkspaceStore store;
    private final NotificationPort notifications;
    private final Contracts contracts;
    private final JsonMapper json=JsonMapper.builder().build();
    public WorkspaceAppService(IdentityRepository identity,IdentityAppService views,ProjectAccessPolicy policy,
            WorkspaceStore store,NotificationPort notifications,Contracts contracts) {
        this.identity=identity;this.views=views;this.policy=policy;this.store=store;this.notifications=notifications;this.contracts=contracts;
    }
    @Transactional(readOnly=true)
    public String access(String actor,String workspace) {
        policy.requireWorkspaceMember(workspace,actor);
        var m=member(workspace,actor);
        return contracts.encode("WorkspaceAccess",new WorkspaceAccess(workspace,m.role().wire,m.version(),views.workspaceVersion(workspace)));
    }
    @Transactional
    public String add(String actor,String workspace,String body) {
        policy.requireWorkspaceAdmin(workspace,actor);
        var input=contracts.decode("WorkspaceMemberAddRequest",body,WorkspaceMemberAddRequest.class);
        return write(actor,workspace,input.requestId(),"add",input.userNo(),body,()->{
            var user=identity.findUserByUserNo(input.userNo()).filter(User::enabled).orElseThrow(()->new ApiProblem(409,"TARGET_UNAVAILABLE"));
            var before=identity.findMember(workspace,user.id());
            if(before.isEmpty()) {
                if(store.memberCount(workspace)>=1000) throw new ApiProblem(409,"WORKSPACE_MEMBER_LIMIT");
                long now=System.currentTimeMillis();
                identity.insertMember(new WorkspaceMember(workspace,user.id(),WorkspaceRole.DEVELOPER,true,1,now,now,now));
            } else if(!before.get().active()) store.rejoin(workspace,user.id());
            else return change(workspace,user.id());
            store.bump(workspace); notifyMembers(actor,workspace,user.id());
            return change(workspace,user.id());
        });
    }
    @Transactional
    public String role(String actor,String workspace,String target,String body) {
        policy.requireWorkspaceAdmin(workspace,actor);
        var input=contracts.decode("WorkspaceRoleChangeRequest",body,WorkspaceRoleChangeRequest.class);
        return write(actor,workspace,input.requestId(),"role",target,body,()->{
            var before=activeMember(workspace,target);
            if(identity.findUserById(target).filter(User::enabled).isEmpty())throw new ApiProblem(409,"TARGET_UNAVAILABLE");
            if(before.version()!=input.expectedVersion()) throw new ApiProblem(409,"VERSION_CONFLICT");
            var role=input.role().equals("admin")?WorkspaceRole.ADMIN:WorkspaceRole.DEVELOPER;
            if(before.role()!=role) {
                if(role==WorkspaceRole.DEVELOPER) protectAdmin(workspace,before);
                store.role(workspace,target,role.db);store.bump(workspace);notifyMembers(actor,workspace,target);
            }
            return change(workspace,target);
        });
    }
    private String change(String workspace,String target) {
        return contracts.encode("WorkspaceMemberChangeResponse",new WorkspaceMemberChangeResponse(views.member(workspace,target),views.workspaceVersion(workspace)));
    }
    private WorkspaceMember member(String workspace,String target) {
        return identity.findMember(workspace,target).orElseThrow(()->new ApiProblem(404,"RESOURCE_NOT_FOUND"));
    }
    private WorkspaceMember activeMember(String workspace,String target) {
        var m=member(workspace,target);
        if(!m.active()) throw new ApiProblem(409,"TARGET_UNAVAILABLE");
        return m;
    }
    private void protectAdmin(String workspace,WorkspaceMember target) {
        if(target.role()==WorkspaceRole.ADMIN && identity.findUserById(target.userId()).filter(User::enabled).isPresent() && store.adminCount(workspace)<=1)
            throw new ApiProblem(409,"LAST_WORKSPACE_ADMIN");
    }
    private record Work(List<WorkTask> tasks,List<WorkProject> projects,List<WorkRepository> repositories,
            List<Map<String,Object>> items,List<ProjectEligibility> eligibility,String version,int shared) {}
    private static String empty(String v) { return v==null || v.isEmpty()?null:v; }
    private static Map<String,Object> fields(Object... values) {
        Map<String,Object> map=new TreeMap<>();for(int i=0;i<values.length;i+=2) map.put((String)values[i],values[i+1]);return map;
    }
    /** 摘要的对象和数组顺序固定；成员/项目资格和责任增删也在摘要内，不能只校验客户端旧列表。 */
    private Work workload(String actor,String workspace,String target) {
        var tasks=store.tasks(workspace,target);var projects=store.projects(workspace,target);var repos=store.repositories(workspace,target);
        List<Map<String,Object>> items=new ArrayList<>();List<ProjectEligibility> eligibility=new ArrayList<>();
        for(var p:projects) {
            items.add(fields("kind","project","projectId",p.id(),"name",p.name(),"status",p.status()==1?"active":"archived","version",p.version(),"ownerUserId",p.owner(),"targetIsOwner",p.owner().equals(target),"targetIsMember",p.targetIsMember()));
            eligibility.add(new ProjectEligibility(p.id(),store.projectMembers(workspace,p.id(),target)));
        }
        for(var t:tasks) {
            List<String> duties=new ArrayList<>();if(t.assignee().equals(target))duties.add("assignee");if(t.creator().equals(target))duties.add("creator");
            items.add(fields("kind","task","taskId",t.id(),"projectId",t.project(),"title",t.title(),"status",workbench.collaboration.domain.task.TaskStatus.fromCode(t.status()).wire,"version",t.version(),"creatorId",t.creator(),"assigneeId",t.assignee(),"conversationId",empty(t.conversation()),"duties",duties,"archived",t.archived()));
        }
        for(var r:repos) items.add(fields("kind","repository","repositoryId",r.id(),"name",r.name(),"status",r.status()==1?"active":"archived","version",r.version(),"ownerUserId",empty(r.owner())));
        items.sort(Comparator.comparing(WorkspaceAppService::itemKey));
        int shared=store.sharedCount(workspace,target);
        var members=views.members(actor,workspace).members().stream().sorted(Comparator.comparing(m->m.user().id())).toList();
        String version=Digests.sha256Hex(json.writeValueAsString(fields("actor",actor,"workspace",workspace,"target",target,"access",views.workspaceVersion(workspace),"members",members,"items",items,"eligibility",eligibility,"shared",shared)));
        return new Work(tasks,projects,repos,items,eligibility,version,shared);
    }
    private static String itemKey(Map<String,Object> item) { String kind=(String)item.get("kind");return kind+":"+item.get(kind+"Id"); }
    @Transactional(readOnly=true)
    public String preview(String actor,String workspace,String target,String after,int limit,String expected) {
        policy.requireWorkspaceAdmin(workspace,actor);activeMember(workspace,target);
        var work=workload(actor,workspace,target);
        if(expected!=null && !expected.equals(work.version())) throw new ApiProblem(409,"HANDOFF_PREVIEW_STALE");
        var remaining=work.items().stream().filter(i->after==null || itemKey(i).compareTo(after)>0).toList();
        var page=remaining.subList(0,Math.min(limit,remaining.size()));
        int archived=(int)work.tasks().stream().filter(WorkTask::archived).count()+(int)work.projects().stream().filter(p->p.status()==2).count()+(int)work.repositories().stream().filter(r->r.status()==2).count();
        return contracts.encode("WorkspaceRemovalPreview",new WorkspaceRemovalPreview(workspace,views.member(workspace,target),views.workspaceVersion(workspace),store.adminCount(workspace),work.version(),page,
            remaining.size()>page.size()?itemKey(page.getLast()):null,Map.of("tasks",work.tasks().size(),"projects",work.projects().size(),"repositories",work.repositories().size(),"archived",archived,"sharedConversations",work.shared()),work.eligibility()));
    }
    @Transactional
    public String remove(String actor,String workspace,String target,String body) {
        policy.requireWorkspaceAdmin(workspace,actor);
        var input=contracts.decode("WorkspaceMemberRemovalRequest",body,WorkspaceMemberRemovalRequest.class);
        return write(actor,workspace,input.requestId(),"remove",target,body,()->{
            var before=activeMember(workspace,target);protectAdmin(workspace,before);
            var work=workload(actor,workspace,target);
            if(before.version()!=input.expectedMemberVersion() || !work.version().equals(input.previewVersion())) throw new ApiProblem(409,"HANDOFF_PREVIEW_STALE");
            Map<String,String> projectChoices=choices(input.projectSuccessors().stream().map(v->new String[]{v.projectId(),v.userId()}).toList());
            Map<String,String> taskChoices=choices(input.taskSuccessors().stream().map(v->new String[]{v.taskId(),v.userId()}).toList());
            Map<String,String> repoChoices=choices(input.repositorySuccessors().stream().map(v->new String[]{v.repositoryId(),v.userId()}).toList());
            Map<String,Set<String>> required=new TreeMap<>();Map<String,String> owners=new TreeMap<>();Map<String,String> assignees=new TreeMap<>();Map<String,String> repoOwners=new TreeMap<>();
            for(var p:work.projects()) if(p.status()==1) {
                boolean creatorWork=work.tasks().stream().anyMatch(t->!t.archived() && t.project().equals(p.id()) && t.creator().equals(target));
                boolean ownerIsActive=work.eligibility().stream().filter(v->v.projectId().equals(p.id())).findFirst().orElseThrow().activeSuccessorUserIds().contains(p.owner());
                boolean needsOwner=p.owner().equals(target) || creatorWork && !ownerIsActive;
                if(needsOwner) {var successor=projectChoices.containsKey(p.id())?projectChoices.remove(p.id()):input.defaultSuccessorUserId();requireSuccessor(workspace,successor,target);owners.put(p.id(),successor);required.computeIfAbsent(p.id(),k->new TreeSet<>()).add(successor);}
                else if(projectChoices.containsKey(p.id())) throw new ApiProblem(400,"INVALID_REQUEST");
            }
            for(var t:work.tasks()) if(!t.archived() && t.assignee().equals(target)) {
                var successor=taskChoices.containsKey(t.id())?taskChoices.remove(t.id()):input.defaultSuccessorUserId();requireSuccessor(workspace,successor,target);assignees.put(t.id(),successor);required.computeIfAbsent(t.project(),k->new TreeSet<>()).add(successor);
            }
            for(var r:work.repositories()) if(r.status()==1) {
                var successor=repoChoices.containsKey(r.id())?repoChoices.remove(r.id()):input.defaultSuccessorUserId();if(successor!=null)requireSuccessor(workspace,successor,target);repoOwners.put(r.id(),successor);
            }
            if(!projectChoices.isEmpty() || !taskChoices.isEmpty() || !repoChoices.isEmpty()) throw new ApiProblem(400,"INVALID_REQUEST");
            Set<String> confirmations=new TreeSet<>();for(var p:input.addToProjects())if(!confirmations.add(p.projectId()+":"+p.userId()))throw new ApiProblem(400,"INVALID_REQUEST");
            Set<String> neededConfirmations=new TreeSet<>();
            for(var e:required.entrySet()) for(var user:e.getValue()) {
                var eligible=work.eligibility().stream().filter(v->v.projectId().equals(e.getKey())).findFirst().orElseThrow().activeSuccessorUserIds();
                if(!eligible.contains(user))neededConfirmations.add(e.getKey()+":"+user);
            }
            if(!confirmations.containsAll(neededConfirmations))throw new ApiProblem(409,"PROJECT_SUCCESSOR_CONFIRMATION_REQUIRED");
            if(!neededConfirmations.containsAll(confirmations))throw new ApiProblem(400,"INVALID_REQUEST");
            // 所有选择验证完毕才开始写；后续任意异常由事务整笔回滚。
            for(var p:input.addToProjects())store.addProjectMember(p.projectId(),p.userId());
            for(var p:work.projects())if(owners.containsKey(p.id()))store.transferProject(p,owners.get(p.id()));
            for(var t:work.tasks())if(assignees.containsKey(t.id())) {
                store.transferTask(t,actor,assignees.get(t.id()));
                notifications.publish("task.assigned",t.id(),Map.of("workspaceId",workspace,"projectId",t.project(),"actorId",actor,"creatorId",t.creator(),"assigneeId",assignees.get(t.id())));
            }
            for(var r:work.repositories())if(repoOwners.containsKey(r.id()))store.transferRepository(r,repoOwners.get(r.id()));
            int stopped=store.remove(workspace,target);
            for(var p:work.projects())if(p.targetIsMember() || owners.containsKey(p.id()))notifications.publish("project.member_changed",p.id(),Map.of("workspaceId",workspace,"projectId",p.id(),"actorId",actor));
            notifyMembers(actor,workspace,target);
            return contracts.encode("WorkspaceMemberRemovalResponse",new WorkspaceMemberRemovalResponse(workspace,views.member(workspace,target),views.workspaceVersion(workspace),input.requestId(),assignees.size(),owners.size(),repoOwners.size(),(int)repoOwners.values().stream().filter(Objects::isNull).count(),stopped));
        });
    }
    private static Map<String,String> choices(List<String[]> entries) {
        Map<String,String> result=new TreeMap<>();for(var e:entries){if(result.containsKey(e[0]))throw new ApiProblem(400,"INVALID_REQUEST");result.put(e[0],e[1]);}return result;
    }
    private boolean validSuccessor(String workspace,String user,String target) {
        return user!=null && !user.equals(target) && identity.memberExists(workspace,user) && identity.findUserById(user).filter(User::enabled).isPresent();
    }
    private void requireSuccessor(String workspace,String user,String target) {
        if(user==null)throw new ApiProblem(409,"HANDOFF_INCOMPLETE");
        if(!validSuccessor(workspace,user,target))throw new ApiProblem(409,"TARGET_UNAVAILABLE");
    }
    private void notifyMembers(String actor,String workspace,String target) { notifications.publish("workspace.member_changed",target,Map.of("workspaceId",workspace,"actorId",actor)); }
    private String write(String actor,String workspace,String request,String action,String target,String body,Supplier<String> operation) {
        String fingerprint=IdempotentCalls.fingerprint(action,target,body);var receipt=store.receipt(workspace,actor,request);
        if(receipt.isPresent()){if(!receipt.get().fingerprint().equals(fingerprint))throw new ApiProblem(409,"REQUEST_ID_CONFLICT");return receipt.get().response();}
        String response=operation.get();
        // 添加入口按工号查找，但事实记录必须保存稳定用户标识，避免后续把工号当成作者 ID。
        String subject=action.equals("add") ? json.readTree(response).path("member").path("user").path("id").asText() : target;
        store.remember(workspace,actor,request,action,subject,fingerprint,body,response);
        return response;
    }
}
