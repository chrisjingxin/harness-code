package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.snapshot.SnapshotRepository;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.persistence.*;
import workbench.collaboration.interfaces.ApiProblem;
import java.util.*;
import static workbench.collaboration.interfaces.dto.KnowledgeDtos.*;

/**
 * 知识提议与保鲜业务：当前资格 → 私有状态/基线 → 审核发布或反馈/复核回执。
 * 所有写操作先取已有 Workspace 行锁，不跨模型或网络持锁；私人草稿不成为发布材料。
 */
@Service
public class KnowledgeWorkflowService {
    private final ProjectAccessPolicy policy;
    private final KnowledgeAppService knowledge;
    private final KnowledgeStore published;
    private final KnowledgeWorkflowStore store;
    private final Contracts contracts;
    private final ConversationRepository conversations;
    private final SnapshotRepository snapshots;
    public KnowledgeWorkflowService(ProjectAccessPolicy policy,KnowledgeAppService knowledge,KnowledgeStore published,KnowledgeWorkflowStore store,Contracts contracts,ConversationRepository conversations,SnapshotRepository snapshots){this.policy=policy;this.knowledge=knowledge;this.published=published;this.store=store;this.contracts=contracts;this.conversations=conversations;this.snapshots=snapshots;}
    private KnowledgeProposal find(String ws,String id){return store.find(ws,id).orElseThrow(()->new ApiProblem(404,"RESOURCE_NOT_FOUND"));}
    private void owner(String actor,KnowledgeProposal p){if(!actor.equals(p.proposerId()))throw new ApiProblem(404,"RESOURCE_NOT_FOUND");}
    private void revision(KnowledgeProposal p,long expected){if(p.revision()!=expected)throw new ApiProblem(409,"VERSION_CONFLICT");}
    private void readable(String actor,String ws,KnowledgeProposal p){if(!actor.equals(p.proposerId())){if(p.submittedAtMs()==null)throw new ApiProblem(404,"RESOURCE_NOT_FOUND");policy.requireWorkspaceAdmin(ws,actor);}}
    private String detail(KnowledgeProposal p){return contracts.encode("KnowledgeProposalDetail",store.detail(p,"",50));}
    private void candidate(String actor,String ws,KnowledgeProposalContent c,boolean submitting){
        knowledge.validateCandidate(ws,c.candidate(),submitting);
        if(c.intent().equals("new")){if(c.targetKnowledgeId()!=null||c.baseVersionId()!=null||c.baseItemVersion()!=null)throw new ApiProblem(400,"INVALID_REQUEST");}
        else{
            if(c.targetKnowledgeId()==null||c.baseVersionId()==null||c.baseItemVersion()==null)throw new ApiProblem(400,"INVALID_REQUEST");
            var item=knowledge.find(ws,c.targetKnowledgeId());knowledge.fixed(ws,item.knowledgeId(),c.baseVersionId());
            if(item.archived())throw new ApiProblem(409,"KNOWLEDGE_ARCHIVED");
            if(submitting&&(!item.currentVersionId().equals(c.baseVersionId())||item.version()!=c.baseItemVersion()))throw new ApiProblem(409,"KNOWLEDGE_BASE_CHANGED");
            if(!item.termKey().equals(c.candidate().termKey()))throw new ApiProblem(400,"INVALID_REQUEST");
        }
        for(var ref:c.relatedReferences())knowledge.fixed(ws,ref.knowledgeId(),ref.versionId());
        if(submitting)for(var source:c.sourceRefs()){
            if(source.kind().equals("proposal")){
                var origin=find(ws,source.referenceId());readable(actor,ws,origin);
                if(origin.submittedAtMs()==null||!Objects.equals(source.revision(),origin.revision())||source.projectId()!=null)throw new ApiProblem(409,"VERSION_CONFLICT");
            } else if(source.kind().equals("local_conversation")){if(source.projectId()!=null)throw new ApiProblem(400,"INVALID_REQUEST");if(!source.referenceId().matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))throw new ApiProblem(400,"INVALID_REQUEST");}
            else if(source.kind().equals("knowledge")){
                var parts=source.referenceId().split(":");if(parts.length!=3||!parts[0].equals("knowledge"))throw new ApiProblem(400,"INVALID_REQUEST");knowledge.fixed(ws,parts[1],parts[2]);
            }else{
                if(source.projectId()==null)throw new ApiProblem(400,"INVALID_REQUEST");policy.requireProject(ws,source.projectId());policy.requireActiveMember(source.projectId(),actor);
                if(source.kind().equals("conversation")){var conv=conversations.findById(source.referenceId()).orElseThrow(()->new ApiProblem(404,"RESOURCE_NOT_FOUND"));if(!conv.projectId().equals(source.projectId()))throw new ApiProblem(404,"RESOURCE_NOT_FOUND");policy.requireConversationOwner(conv,actor);}
                else if(snapshots.findInProject(source.projectId(),source.referenceId()).isEmpty())throw new ApiProblem(404,"RESOURCE_NOT_FOUND");
            }
        }
    }
    private <T> T decode(String type,String raw,Class<T> target){if(!contracts.valid(type,raw))throw new ApiProblem(400,"INVALID_REQUEST");return contracts.decode(type,raw,target);}
    @Transactional
    public String create(String actor,String ws,String raw){policy.requireWorkspaceMember(ws,actor);var in=decode("KnowledgeProposalCreateRequest",raw,KnowledgeProposalCreateRequest.class);return store.once(ws,actor,in.requestId(),"proposal:create",in,()->{candidate(actor,ws,in.content(),in.submit());String id=UUID.randomUUID().toString();store.create(ws,actor,id,in.content(),in.submit());return detail(find(ws,id));});}
    @Transactional(readOnly=true)
    public String read(String actor,String ws,String id,String after,int limit){policy.requireWorkspaceMember(ws,actor);var p=find(ws,id);readable(actor,ws,p);return contracts.encode("KnowledgeProposalDetail",store.detail(p,after,limit));}
    @Transactional(readOnly=true)
    public String list(String actor,String ws,String view,String status,String after,int limit){policy.requireWorkspaceMember(ws,actor);boolean review="review".equals(view);if(review)policy.requireWorkspaceAdmin(ws,actor);var rows=store.list(ws,actor,review,status,after,limit+1);var page=rows.subList(0,Math.min(limit,rows.size()));return contracts.encode("KnowledgeProposalListResponse",new KnowledgeProposalListResponse(page,rows.size()>limit?page.getLast().proposalId():null));}
    @Transactional
    public String edit(String actor,String ws,String id,String raw){policy.requireWorkspaceMember(ws,actor);var p=find(ws,id);owner(actor,p);var in=decode("KnowledgeProposalUpdateRequest",raw,KnowledgeProposalUpdateRequest.class);return store.once(ws,actor,in.requestId(),"proposal:edit:"+id,in,()->{revision(p,in.expectedRevision());if(!Set.of("draft","returned").contains(p.status()))throw new ApiProblem(409,"PROPOSAL_STATE_CONFLICT");candidate(actor,ws,in.content(),false);store.change(p,actor,p.status(),in.content(),p.lastReason(),null,null,null,"");return detail(find(ws,id));});}
    @Transactional
    public String action(String actor,String ws,String id,String action,String raw){policy.requireWorkspaceMember(ws,actor);var p=find(ws,id);owner(actor,p);var in=decode("KnowledgeProposalActionRequest",raw,KnowledgeProposalActionRequest.class);return store.once(ws,actor,in.requestId(),"proposal:"+action+":"+id,in,()->{revision(p,in.expectedRevision());if(action.equals("submit")){if(!in.confirmShare()||!Set.of("draft","returned").contains(p.status()))throw new ApiProblem(409,"PROPOSAL_STATE_CONFLICT");candidate(actor,ws,p.content(),true);}else if(!Set.of("draft","returned","submitted").contains(p.status()))throw new ApiProblem(409,"PROPOSAL_STATE_CONFLICT");store.change(p,actor,action.equals("submit")?"submitted":"withdrawn",p.content(),"",null,null,null,"");return detail(find(ws,id));});}
    @Transactional
    public String review(String actor,String ws,String id,String raw){
        policy.requireWorkspaceAdmin(ws,actor);var in=decode("KnowledgeProposalReviewRequest",raw,KnowledgeProposalReviewRequest.class);
        return store.once(ws,actor,in.requestId(),"proposal:review:"+id,in,()->{
            var p=find(ws,id);if(p.submittedAtMs()==null)throw new ApiProblem(404,"RESOURCE_NOT_FOUND");revision(p,in.expectedRevision());
            if(!p.status().equals("submitted"))throw new ApiProblem(409,"PROPOSAL_STATE_CONFLICT");
            if(in.decision().equals("return")){if(in.note().isBlank())throw new ApiProblem(400,"REVIEW_REASON_REQUIRED");store.change(p,actor,"returned",p.content(),in.note(),null,null,actor,"");return detail(find(ws,id));}
            if(!p.proposerActive())throw new ApiProblem(409,"PROPOSER_MEMBERSHIP_CHANGED");
            var c=p.content();if(!Objects.equals(c.baseVersionId(),in.baseVersionId())||!Objects.equals(c.baseItemVersion(),in.expectedItemVersion()))throw new ApiProblem(409,"KNOWLEDGE_BASE_CHANGED");
            // 原来源摘要已经由提议人明确共享给管理员；审核不会替管理员取得源 Project 正文权限。
            knowledge.validateCandidate(ws,c.candidate(),true);
            var finalCandidate=in.finalCandidate()==null?c.candidate():in.finalCandidate();if(in.finalCandidate()!=null&&in.note().isBlank())throw new ApiProblem(400,"REVIEW_REASON_REQUIRED");
            String knowledgeId,versionId,outcome;
            if(c.intent().equals("archive")){
                var current=knowledge.find(ws,c.targetKnowledgeId());if(!current.currentVersionId().equals(c.baseVersionId())||current.version()!=c.baseItemVersion())throw new ApiProblem(409,"KNOWLEDGE_BASE_CHANGED");
                knowledge.archivePublished(actor,ws,current.knowledgeId(),current.version());knowledgeId=current.knowledgeId();versionId=current.currentVersionId();outcome="archived";
            }else{
                var people=new TreeSet<String>();people.add(p.proposerId());for(var source:c.sourceRefs())if(source.kind().equals("proposal")){var origin=find(ws,source.referenceId());if(origin.submittedAtMs()==null)throw new ApiProblem(404,"RESOURCE_NOT_FOUND");people.add(origin.proposerId());}for(var source:c.relatedReferences())people.addAll(knowledge.fixed(ws,source.knowledgeId(),source.versionId()).version().contributors());
                if(c.targetKnowledgeId()!=null)people.addAll(knowledge.fixed(ws,c.targetKnowledgeId(),c.baseVersionId()).version().contributors());
                var result=knowledge.publish(actor,ws,c.targetKnowledgeId(),c.baseItemVersion(),c.baseVersionId(),finalCandidate,List.copyOf(people),id);knowledgeId=result.item().knowledgeId();versionId=result.current().version().versionId();outcome="published";
            }
            var finalContent=new KnowledgeProposalContent(c.intent(),c.targetKnowledgeId(),c.baseVersionId(),c.baseItemVersion(),finalCandidate,c.relatedReferences(),c.sourceSummary(),c.sourceRefs(),c.generationKind());
            store.change(p,actor,"published",finalContent,in.note(),knowledgeId,versionId,actor,outcome);return detail(find(ws,id));
        });
    }
    @Transactional
    public String readHit(String actor,String ws,String id,String version,String raw){policy.requireWorkspaceMember(ws,actor);var in=decode("KnowledgeReadRequest",raw,KnowledgeReadRequest.class);knowledge.fixed(ws,id,version);store.recordRead(id,version,in.readId());return contracts.encode("KnowledgeUsageResponse",new KnowledgeUsageResponse(published.versionReads(version),published.totalReads(id)));}
    @Transactional(readOnly=true)
    public String feedback(String actor,String ws,String id,String version){policy.requireWorkspaceMember(ws,actor);knowledge.fixed(ws,id,version);return contracts.encode("KnowledgeFeedbackResponse",store.feedback(actor,id,version,published));}
    @Transactional
    public String feedback(String actor,String ws,String id,String version,String raw){policy.requireWorkspaceMember(ws,actor);var in=decode("KnowledgeFeedbackRequest",raw,KnowledgeFeedbackRequest.class);knowledge.fixed(ws,id,version);return store.once(ws,actor,in.requestId(),"feedback:"+id+":"+version,in,()->{store.feedback(actor,id,version,in);return contracts.encode("KnowledgeFeedbackResponse",store.feedback(actor,id,version,published));});}
    @Transactional(readOnly=true)
    public String reviewDetail(String actor,String ws,String id,String after,int limit){policy.requireWorkspaceAdmin(ws,actor);return contracts.encode("KnowledgeReviewDetail",store.reviewDetail(knowledge.find(ws,id),after,limit));}
    @Transactional
    public String confirm(String actor,String ws,String id,String raw){policy.requireWorkspaceAdmin(ws,actor);var in=decode("KnowledgeReviewRequest",raw,KnowledgeReviewRequest.class);return store.once(ws,actor,in.requestId(),"confirm:"+id,in,()->{var item=knowledge.find(ws,id);if(item.archived()||item.version()!=in.expectedItemVersion()||!item.currentVersionId().equals(in.currentVersionId())||in.feedbackWatermark()>item.health().feedbackWatermark())throw new ApiProblem(409,"VERSION_CONFLICT");if(in.note().isBlank())throw new ApiProblem(400,"REVIEW_REASON_REQUIRED");store.reviewEvent(actor,id,item.currentVersionId(),"confirmed_valid","",in.note());published.markReviewed(ws,id,in.feedbackWatermark());return contracts.encode("KnowledgeReviewDetail",store.reviewDetail(knowledge.find(ws,id),"",50));});}
}
