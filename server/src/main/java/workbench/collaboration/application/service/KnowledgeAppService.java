package workbench.collaboration.application.service;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.KnowledgeStore;
import workbench.collaboration.infrastructure.persistence.KnowledgeWorkflowStore;
import workbench.collaboration.interfaces.ApiProblem;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static workbench.collaboration.interfaces.dto.KnowledgeDtos.*;

/**
 * 唯一知识发布服务：团队锁/当前权限 → 候选与基线校验 → 只追加版本 → 当前指针与通知同事务提交。
 * 自动候选由提议服务审核后调用 publish；普通手工写入口仍只允许管理员。
 */
@Service
public class KnowledgeAppService {
    private final ProjectAccessPolicy policy;
    private final KnowledgeStore store;
    private final KnowledgeWorkflowStore workflow;
    private final NotificationPort notifications;
    private final Contracts contracts;
    public KnowledgeAppService(ProjectAccessPolicy policy,KnowledgeStore store,KnowledgeWorkflowStore workflow,NotificationPort notifications,Contracts contracts){this.policy=policy;this.store=store;this.workflow=workflow;this.notifications=notifications;this.contracts=contracts;}
    private <T> T decode(String type,String raw,Class<T> target){if(!contracts.valid(type,raw))throw new ApiProblem(400,"INVALID_REQUEST");return contracts.decode(type,raw,target);}
    @Transactional
    public String create(String actor,String workspace,String raw){
        policy.requireWorkspaceAdmin(workspace,actor);var in=decode("KnowledgeCreateRequest",raw,KnowledgeCreateRequest.class);
        return workflow.once(workspace,actor,in.requestId(),"create",in,()->contracts.encode("KnowledgeDetail",publish(actor,workspace,null,null,null,new KnowledgeCandidate(in.termKey(),in.category(),in.title(),in.text(),in.level(),in.scope(),in.contentType()),List.of(actor),null)));
    }
    @Transactional
    public String edit(String actor,String workspace,String id,String raw){
        policy.requireWorkspaceAdmin(workspace,actor);var in=decode("KnowledgeUpdateRequest",raw,KnowledgeUpdateRequest.class);
        return workflow.once(workspace,actor,in.requestId(),"edit:"+id,in,()->{var before=find(workspace,id);return contracts.encode("KnowledgeDetail",publish(actor,workspace,id,in.expectedVersion(),before.currentVersionId(),new KnowledgeCandidate(before.termKey(),in.category(),in.title(),in.text(),in.level(),in.scope(),in.contentType()),List.of(actor),null));});
    }
    /** 调用者必须处于写事务；重新检查管理员与当前版本，不相信提议页面上的旧判断。 */
    @Transactional(propagation=org.springframework.transaction.annotation.Propagation.MANDATORY)
    public KnowledgeDetail publish(String actor,String workspace,String id,Long expected,String baseVersion,KnowledgeCandidate c,List<String> contributors,String proposalId){
        policy.requireWorkspaceAdmin(workspace,actor);validateCandidate(workspace,c,true);
        var before=id==null?null:find(workspace,id);
        if(before!=null){
            if(before.archived())throw new ApiProblem(409,"KNOWLEDGE_ARCHIVED");
            if(!Objects.equals(expected,before.version())||!Objects.equals(baseVersion,before.currentVersionId()))throw new ApiProblem(409,"KNOWLEDGE_BASE_CHANGED");
            if(!before.termKey().equals(c.termKey()))throw new ApiProblem(400,"INVALID_REQUEST");
        }
        String key=id==null?UUID.randomUUID().toString():id;long number=before==null?1:before.version()+1, now=System.currentTimeMillis();
        var people=new TreeSet<>(contributors);people.add(actor);
        var v=new KnowledgeVersionSummary(UUID.randomUUID().toString(),number,c.category(),c.title(),actor,now,c.level(),c.scope(),c.contentType(),List.copyOf(people),proposalId,actor,now);
        var item=new KnowledgeSummary(key,c.termKey(),c.category(),c.title(),v.versionId(),number,false,now,c.level(),c.scope(),c.contentType(),new KnowledgeHealth(0,0,0,false,now,0));
        try{if(before==null)store.insert(workspace,item);else if(!store.update(workspace,item,expected))throw new ApiProblem(409,"VERSION_CONFLICT");store.append(key,v,c.text());}catch(DuplicateKeyException e){throw new ApiProblem(409,"KNOWLEDGE_KEY_EXISTS");}
        store.markReviewed(workspace,key,0);
        notifications.publish("knowledge.updated",key,Map.of("workspaceId",workspace,"actorId",actor));
        return detail(find(workspace,key));
    }
    /** draft 允许暂存超长规约；提交或发布才要求正文预算，避免丢失用户修改。 */
    public void validateCandidate(String workspace,KnowledgeCandidate c,boolean submitting){
        if(c.title().isBlank()||c.text().isBlank()||c.category().isBlank())throw new ApiProblem(400,"INVALID_REQUEST");
        if(submitting&&c.level().equals("rule")&&c.text().getBytes(StandardCharsets.UTF_8).length>4096)throw new ApiProblem(400,"RULE_BODY_TOO_LARGE");
        for(String repo:c.scope().repositoryIds())if(!(submitting?store.activeRepository(workspace,repo):store.repositoryExists(workspace,repo)))throw new ApiProblem(400,"REPOSITORY_UNAVAILABLE");
    }
    @Transactional
    public String archive(String actor,String workspace,String id,long expected,String requestId){
        policy.requireWorkspaceAdmin(workspace,actor);return workflow.once(workspace,actor,requestId,"archive:"+id,Map.of("expectedVersion",expected),()->archivePublished(actor,workspace,id,expected));
    }
    /** 审核事务内部归档，外层已保存同一审核请求回执，不重复占用 requestId。 */
    @Transactional(propagation=org.springframework.transaction.annotation.Propagation.MANDATORY)
    public String archivePublished(String actor,String workspace,String id,long expected){
        policy.requireWorkspaceAdmin(workspace,actor);var before=find(workspace,id);
        if(before.archived())throw new ApiProblem(409,"KNOWLEDGE_ARCHIVED");
        var after=new KnowledgeSummary(id,before.termKey(),before.category(),before.title(),before.currentVersionId(),before.version()+1,true,System.currentTimeMillis(),before.level(),before.scope(),before.contentType(),before.health());
        if(before.version()!=expected||!store.update(workspace,after,expected))throw new ApiProblem(409,"VERSION_CONFLICT");
        notifications.publish("knowledge.updated",id,Map.of("workspaceId",workspace,"actorId",actor));return contracts.encode("KnowledgeDetail",detail(find(workspace,id)));
    }
    @Transactional(readOnly=true)
    public String read(String actor,String workspace,String id){policy.requireWorkspaceMember(workspace,actor);return contracts.encode("KnowledgeDetail",detail(find(workspace,id)));}
    @Transactional(readOnly=true)
    public String readVersion(String actor,String workspace,String id,String version){policy.requireWorkspaceMember(workspace,actor);return contracts.encode("KnowledgeVersion",fixed(workspace,id,version));}
    @Transactional(readOnly=true)
    public String versions(String actor,String workspace,String id,String after,int limit){policy.requireWorkspaceMember(workspace,actor);find(workspace,id);var rows=store.versions(id,after,limit+1);var page=rows.subList(0,Math.min(rows.size(),limit));return contracts.encode("KnowledgeVersionListResponse",new KnowledgeVersionListResponse(page,rows.size()>limit?page.getLast().versionId():null));}
    @Transactional(readOnly=true)
    public String list(String actor,String workspace,String category,String query,String level,String mode,List<String> repos,String after,int limit){policy.requireWorkspaceMember(workspace,actor);return page(workspace,category,query,level,mode,repos,after,limit,false);}
    @Transactional(readOnly=true)
    public String reviews(String actor,String workspace,String after,int limit){policy.requireWorkspaceAdmin(workspace,actor);return page(workspace,null,null,null,"all",List.of(),after,limit,true);}
    private String page(String workspace,String category,String query,String level,String mode,List<String> repos,String after,int limit,boolean reviews){var rows=store.list(workspace,category,query,level,mode,repos,after,limit+1,reviews);var page=rows.subList(0,Math.min(rows.size(),limit));return contracts.encode("KnowledgeListResponse",new KnowledgeListResponse(page,rows.size()>limit?page.getLast().knowledgeId():null));}
    public KnowledgeSummary find(String workspace,String id){return store.find(workspace,id).orElseThrow(()->new ApiProblem(404,"RESOURCE_NOT_FOUND"));}
    public KnowledgeVersion fixed(String workspace,String id,String version){var item=find(workspace,id);return store.version(item,version).orElseThrow(()->new ApiProblem(404,"RESOURCE_NOT_FOUND"));}
    private KnowledgeDetail detail(KnowledgeSummary item){return new KnowledgeDetail(item,store.version(item,item.currentVersionId()).orElseThrow());}
}
