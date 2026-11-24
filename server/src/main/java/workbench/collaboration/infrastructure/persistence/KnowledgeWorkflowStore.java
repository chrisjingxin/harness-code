package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.interfaces.ApiProblem;
import javax.sql.DataSource;
import java.sql.*;
import java.time.LocalDateTime;
import java.util.*;
import java.util.function.Supplier;
import static workbench.collaboration.interfaces.dto.KnowledgeDtos.*;

/**
 * 私人候选、提交快照和保鲜记录；调用方先持有团队锁并复核当前身份。
 * 提议 JSON 与已发布版本分离 → 状态变化保存事件快照 → 发布回执可重试。
 */
@Repository
public class KnowledgeWorkflowStore {
    private final JdbcTemplate jdbc;
    private final JsonMapper json=JsonMapper.builder().build();
    public KnowledgeWorkflowStore(DataSource source){jdbc=new JdbcTemplate(source);}
    public boolean active(String workspace,String user){return jdbc.queryForObject("SELECT COUNT(*) FROM wb_workspace_member m JOIN wb_user u ON u.user_id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND m.status=1 AND u.enabled=1",Long.class,workspace,user)==1;}
    private long memberVersion(String ws,String actor){return jdbc.queryForObject("SELECT version FROM wb_workspace_member WHERE workspace_id=? AND user_id=?",Long.class,ws,actor);}
    private static String empty(String s){return s==null?"":s;}
    private static String optional(String s){return s.isEmpty()?null:s;}
    private KnowledgeProposal proposalRow(ResultSet r)throws SQLException{
        var submitted=r.getObject("submitted_at",LocalDateTime.class);
        return new KnowledgeProposal(r.getString("proposal_id"),r.getString("workspace_id"),r.getString("proposer_id"),json.readValue(r.getString("content"),KnowledgeProposalContent.class),r.getLong("revision"),r.getString("status"),Times.ms(r.getObject("created_at",LocalDateTime.class)),Times.ms(r.getObject("updated_at",LocalDateTime.class)),submitted==null?null:Times.ms(submitted),r.getString("last_reason"),optional(r.getString("published_knowledge_id")),optional(r.getString("published_version_id")),optional(r.getString("reviewer_id")),r.getString("outcome"),(active(r.getString("workspace_id"),r.getString("proposer_id")) && memberVersion(r.getString("workspace_id"),r.getString("proposer_id"))==r.getLong("proposer_member_version")));
    }
    public Optional<KnowledgeProposal> find(String workspace,String id){return jdbc.query("SELECT * FROM wb_knowledge_proposal WHERE workspace_id=? AND proposal_id=?",(r,i)->proposalRow(r),workspace,id).stream().findFirst();}
    public void create(String workspace,String actor,String id,KnowledgeProposalContent content,boolean submit){
        jdbc.update("INSERT INTO wb_knowledge_proposal (proposal_id,workspace_id,proposer_id,proposer_member_version,content,revision,status,created_at,updated_at,submitted_at,last_reason,published_knowledge_id,published_version_id,reviewer_id,outcome) VALUES (?,?,?,?,?,1,?,NOW(3),NOW(3),?,'','','','','')",id,workspace,actor,memberVersion(workspace,actor),json.writeValueAsString(content),submit?"submitted":"draft",submit?LocalDateTime.now():null);
        if(submit)event(id,actor,"submitted","",content);
    }
    public void change(KnowledgeProposal p,String actor,String state,KnowledgeProposalContent content,String note,String knowledgeId,String versionId,String reviewer,String outcome){
        jdbc.update("UPDATE wb_knowledge_proposal SET proposer_member_version=CASE WHEN ?='submitted' THEN ? ELSE proposer_member_version END,content=?,status=?,revision=revision+1,updated_at=NOW(3),submitted_at=CASE WHEN ?='submitted' THEN NOW(3) ELSE submitted_at END,last_reason=?,published_knowledge_id=?,published_version_id=?,reviewer_id=?,outcome=? WHERE proposal_id=? AND revision=?",state,memberVersion(p.workspaceId(),p.proposerId()),json.writeValueAsString(content),state,state,note,empty(knowledgeId),empty(versionId),empty(reviewer),outcome,p.proposalId(),p.revision());
        // 事件只保留明确提交与审核动作，编辑草稿不冒充一次新的审核提交。
        if(!state.equals("draft")&&!state.equals("returned")||reviewer!=null)event(p.proposalId(),actor,state,note,content);
    }
    private void event(String id,String actor,String kind,String note,KnowledgeProposalContent content){jdbc.update("INSERT INTO wb_knowledge_proposal_event (proposal_id,actor_id,kind,note,content,created_at) VALUES (?,?,?,?,?,NOW(3))",id,actor,kind,note,json.writeValueAsString(content));}
    public KnowledgeProposalDetail detail(KnowledgeProposal p,String after,int limit){
        var rows=jdbc.query("SELECT * FROM wb_knowledge_proposal_event WHERE proposal_id=? AND id>? ORDER BY id LIMIT ?",(r,i)->new KnowledgeProposalEvent(r.getString("id"),r.getString("kind"),r.getString("actor_id"),r.getString("note"),json.readValue(r.getString("content"),KnowledgeProposalContent.class),Times.ms(r.getObject("created_at",LocalDateTime.class))),p.proposalId(),after.isEmpty()?0:Long.parseLong(after),limit+1);
        var page=rows.subList(0,Math.min(limit,rows.size()));return new KnowledgeProposalDetail(p,page,rows.size()>limit?page.getLast().eventId():null);
    }
    public List<KnowledgeProposalSummary> list(String workspace,String actor,boolean review,String status,String after,int limit){
        List<Object> args=new ArrayList<>(List.of(workspace,after));String where=review?" AND submitted_at IS NOT NULL":" AND proposer_id=?";if(!review)args.add(actor);
        if(status!=null){where+=" AND status=?";args.add(status);}args.add(limit);
        return jdbc.query("SELECT * FROM wb_knowledge_proposal WHERE workspace_id=? AND proposal_id>?"+where+" ORDER BY proposal_id LIMIT ?",(r,i)->{var p=proposalRow(r);return new KnowledgeProposalSummary(p.proposalId(),p.proposerId(),p.content().candidate().title(),p.content().candidate().level(),p.status(),p.revision(),p.updatedAtMs(),p.proposerActive());},args.toArray());
    }
    /** 资格检查在回执之前进行，旧成功请求不能替已撤权身份重新取得内容。 */
    public String once(String workspace,String actor,String request,String action,Object input,Supplier<String> run){
        String fingerprint=workbench.collaboration.infrastructure.contract.Digests.sha256Hex(json.writeValueAsString(input));
        var rows=jdbc.queryForList("SELECT action,fingerprint,response FROM wb_knowledge_request WHERE workspace_id=? AND actor_id=? AND request_id=?",workspace,actor,request);
        if(!rows.isEmpty()){var row=rows.getFirst();if(!action.equals(row.get("action"))||!fingerprint.equals(row.get("fingerprint")))throw new ApiProblem(409,"IDEMPOTENCY_CONFLICT");return (String)row.get("response");}
        String response=run.get();jdbc.update("INSERT INTO wb_knowledge_request (workspace_id,actor_id,request_id,action,fingerprint,response) VALUES (?,?,?,?,?,?)",workspace,actor,request,action,fingerprint,response);return response;
    }
    public void recordRead(String id,String version,String readId){
        var previous=jdbc.queryForList("SELECT knowledge_id,version_id FROM wb_knowledge_read_receipt WHERE read_id=?",readId);
        if(!previous.isEmpty()){if(!id.equals(previous.getFirst().get("knowledge_id"))||!version.equals(previous.getFirst().get("version_id")))throw new ApiProblem(409,"IDEMPOTENCY_CONFLICT");return;}
        jdbc.update("INSERT INTO wb_knowledge_read_receipt (read_id,knowledge_id,version_id,created_at) VALUES (?,?,?,NOW(3))",readId,id,version);
        jdbc.update("INSERT INTO wb_knowledge_usage (knowledge_id,version_id,read_count) VALUES (?,?,1) ON DUPLICATE KEY UPDATE read_count=read_count+1",id,version);
    }
    public KnowledgeFeedbackResponse feedback(String actor,String id,String version,KnowledgeStore published){
        var own=jdbc.queryForList("SELECT value,note FROM wb_knowledge_feedback WHERE version_id=? AND user_id=?",version,actor);
        return new KnowledgeFeedbackResponse(own.isEmpty()?null:optional((String)own.getFirst().get("value")),own.isEmpty()?"":(String)own.getFirst().get("note"),published.votes(version,"useful"),published.votes(version,"expired"),published.versionReads(version));
    }
    public void feedback(String actor,String id,String version,KnowledgeFeedbackRequest input){
        long event=reviewEvent(actor,id,version,"feedback",empty(input.value()),input.note());
        jdbc.update("INSERT INTO wb_knowledge_feedback (knowledge_id,version_id,user_id,value,note,event_id) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE value=VALUES(value),note=VALUES(note),event_id=VALUES(event_id)",id,version,actor,empty(input.value()),input.note(),event);
    }
    public long reviewEvent(String actor,String id,String version,String kind,String value,String note){
        var keys=new GeneratedKeyHolder();jdbc.update(c->{var p=c.prepareStatement("INSERT INTO wb_knowledge_review_event (knowledge_id,version_id,actor_id,kind,value,note,created_at) VALUES (?,?,?,?,?,?,NOW(3))",Statement.RETURN_GENERATED_KEYS);p.setString(1,id);p.setString(2,version);p.setString(3,actor);p.setString(4,kind);p.setString(5,value);p.setString(6,note);return p;},keys);return Objects.requireNonNull(keys.getKey()).longValue();
    }
    public KnowledgeReviewDetail reviewDetail(KnowledgeSummary item,String after,int limit){
        var rows=jdbc.query("SELECT * FROM wb_knowledge_review_event WHERE knowledge_id=? AND id>? ORDER BY id LIMIT ?",(r,i)->new KnowledgeReviewEvent(r.getString("id"),r.getString("actor_id"),r.getString("kind"),r.getString("version_id"),r.getString("note"),optional(r.getString("value")),Times.ms(r.getObject("created_at",LocalDateTime.class))),item.knowledgeId(),after.isEmpty()?0:Long.parseLong(after),limit+1);
        var page=rows.subList(0,Math.min(limit,rows.size()));return new KnowledgeReviewDetail(item,page,rows.size()>limit?page.getLast().eventId():null);
    }
}
