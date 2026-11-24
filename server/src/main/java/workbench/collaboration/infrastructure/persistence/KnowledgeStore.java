package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.interfaces.ApiProblem;
import javax.sql.DataSource;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDateTime;
import java.util.*;
import static workbench.collaboration.interfaces.dto.KnowledgeDtos.*;

/**
 * 已发布知识的唯一持久化入口。提议不进入这里的版本、范围或检索投影。
 * 当前指针 → 固定版本元数据与范围 → 使用/复核摘要；正文只追加，不覆盖旧版。
 */
@Repository
public class KnowledgeStore {
    private final JdbcTemplate jdbc;
    private final JsonMapper json = JsonMapper.builder().build();
    public KnowledgeStore(DataSource source) { jdbc = new JdbcTemplate(source); }
    private static String nullable(String value) { return value == null || value.isEmpty() ? null : value; }
    private static Long millis(LocalDateTime value) { return value == null ? null : Times.ms(value); }
    private KnowledgeScope scope(String versionId, String kind) {
        return new KnowledgeScope(kind, jdbc.query("SELECT repository_id FROM wb_knowledge_version_repository WHERE version_id=? ORDER BY repository_id", (r,i)->r.getString(1), versionId));
    }
    private KnowledgeVersionSummary versionRow(ResultSet r) throws SQLException {
        return new KnowledgeVersionSummary(r.getString("version_id"),r.getLong("version"),r.getString("category"),r.getString("title"),r.getString("author_id"),Times.ms(r.getObject("created_at",LocalDateTime.class)),
                r.getString("level"),scope(r.getString("version_id"),r.getString("scope_kind")),r.getString("content_type"),List.of(json.readValue(r.getString("contributors"),String[].class)),nullable(r.getString("proposal_id")),nullable(r.getString("reviewer_id")),millis(r.getObject("reviewed_at",LocalDateTime.class)));
    }
    private KnowledgeSummary itemRow(ResultSet r) throws SQLException {
        String id=r.getString("knowledge_id"), versionId=r.getString("current_version_id");
        var meta=jdbc.query("SELECT * FROM wb_knowledge_version WHERE knowledge_id=? AND version_id=?",(v,i)->versionRow(v),id,versionId).stream().findFirst().orElseThrow(()->new ApiProblem(503,"KNOWLEDGE_METADATA_REQUIRED"));
        Long reviewed=millis(r.getObject("last_reviewed_at",LocalDateTime.class));
        long watermark=jdbc.queryForObject("SELECT COALESCE(MAX(event_id),0) FROM wb_knowledge_feedback WHERE version_id=?",Long.class,versionId);
        long unresolved=jdbc.queryForObject("SELECT COUNT(*) FROM wb_knowledge_feedback WHERE version_id=? AND value='expired' AND event_id>?",Long.class,versionId,r.getLong("reviewed_feedback_id"));
        var health=new KnowledgeHealth(totalReads(id),votes(versionId,"useful"),votes(versionId,"expired"),!r.getBoolean("archived")&&(reviewed==null||reviewed<System.currentTimeMillis()-90L*86400000||unresolved>0),reviewed,watermark);
        return new KnowledgeSummary(id,r.getString("term_key"),r.getString("category"),r.getString("title"),versionId,r.getLong("version"),r.getBoolean("archived"),Times.ms(r.getObject("updated_at",LocalDateTime.class)),meta.level(),meta.scope(),meta.contentType(),health);
    }
    public long votes(String versionId,String value) { return jdbc.queryForObject("SELECT COUNT(*) FROM wb_knowledge_feedback WHERE version_id=? AND value=?",Long.class,versionId,value); }
    public long totalReads(String id) { return jdbc.queryForObject("SELECT COALESCE(SUM(read_count),0) FROM wb_knowledge_usage WHERE knowledge_id=?",Long.class,id); }
    public long versionReads(String id) { return jdbc.queryForObject("SELECT COALESCE(MAX(read_count),0) FROM wb_knowledge_usage WHERE version_id=?",Long.class,id); }
    public void insert(String workspace,KnowledgeSummary item) {
        jdbc.update("INSERT INTO wb_knowledge_item (workspace_id,knowledge_id,term_key,category,title,current_version_id,version,archived,updated_at,last_reviewed_at) VALUES (?,?,?,?,?,?,1,0,?,?)",workspace,item.knowledgeId(),item.termKey(),item.category(),item.title(),item.currentVersionId(),Times.ofMs(item.updatedAtMs()),Times.ofMs(item.updatedAtMs()));
    }
    public void append(String id,KnowledgeVersionSummary v,String text) {
        jdbc.update("INSERT INTO wb_knowledge_version (knowledge_id,version_id,version,category,title,author_id,text,level,scope_kind,content_type,contributors,proposal_id,reviewer_id,reviewed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",id,v.versionId(),v.version(),v.category(),v.title(),v.authorId(),text,v.level(),v.scope().kind(),v.contentType(),json.writeValueAsString(v.contributors()),v.proposalId()==null?"":v.proposalId(),v.reviewerId()==null?"":v.reviewerId(),v.reviewedAtMs()==null?null:Times.ofMs(v.reviewedAtMs()),Times.ofMs(v.createdAtMs()));
        for(String repo:new TreeSet<>(v.scope().repositoryIds())) jdbc.update("INSERT INTO wb_knowledge_version_repository (version_id,repository_id) VALUES (?,?)",v.versionId(),repo);
    }
    public Optional<KnowledgeSummary> find(String workspace,String id) {
        return jdbc.query("SELECT * FROM wb_knowledge_item WHERE workspace_id=? AND knowledge_id=?",(r,i)->itemRow(r),workspace,id).stream().findFirst();
    }
    public boolean update(String workspace,KnowledgeSummary item,long expected) {
        return jdbc.update("UPDATE wb_knowledge_item SET category=?,title=?,current_version_id=?,version=version+1,archived=?,updated_at=? WHERE workspace_id=? AND knowledge_id=? AND version=? AND archived=0",item.category(),item.title(),item.currentVersionId(),item.archived(),Times.ofMs(item.updatedAtMs()),workspace,item.knowledgeId(),expected)==1;
    }
    public void markReviewed(String workspace,String id,long watermark) { jdbc.update("UPDATE wb_knowledge_item SET last_reviewed_at=?,reviewed_feedback_id=GREATEST(reviewed_feedback_id,?) WHERE workspace_id=? AND knowledge_id=?",LocalDateTime.now(),watermark,workspace,id); }
    public Optional<KnowledgeVersion> version(KnowledgeSummary item,String versionId) {
        return jdbc.query("SELECT * FROM wb_knowledge_version WHERE knowledge_id=? AND version_id=?",(r,i)->new KnowledgeVersion(item.knowledgeId(),item.termKey(),item.archived(),versionRow(r),r.getString("text")),item.knowledgeId(),versionId).stream().findFirst();
    }
    public List<KnowledgeVersionSummary> versions(String id,String after,int limit) {
        return jdbc.query("SELECT * FROM wb_knowledge_version WHERE knowledge_id=? AND (?='' OR version < (SELECT v.version FROM wb_knowledge_version v WHERE v.knowledge_id=? AND v.version_id=?)) ORDER BY version DESC LIMIT ?",(r,i)->versionRow(r),id,after,id,after,limit);
    }
    /** 在数据库分页之前筛选范围；不能把第一页过滤后误当全部匹配条目。 */
    public List<KnowledgeSummary> list(String workspace,String category,String query,String level,String scopeMode,List<String> repositories,String after,int limit,boolean reviews) {
        List<Object> args=new ArrayList<>(List.of(workspace,after));
        StringBuilder sql=new StringBuilder("SELECT i.* FROM wb_knowledge_item i JOIN wb_knowledge_version v ON v.version_id=i.current_version_id WHERE i.workspace_id=? AND i.knowledge_id>? AND i.archived=0");
        if(category!=null){sql.append(" AND i.category COLLATE utf8mb4_bin=?");args.add(category);}
        if(query!=null){sql.append(" AND LOCATE(?,CONCAT_WS(' ',i.term_key,i.title,v.text))>0");args.add(query);}
        if(level!=null){sql.append(" AND v.level=?");args.add(level);}
        if("applicable".equals(scopeMode)){
            sql.append(" AND (v.scope_kind='workspace'");
            if(!repositories.isEmpty()){sql.append(" OR EXISTS (SELECT 1 FROM wb_knowledge_version_repository vr WHERE vr.version_id=v.version_id AND vr.repository_id IN ("+String.join(",",Collections.nCopies(repositories.size(),"?"))+"))");args.addAll(repositories);}
            sql.append(")");
        }
        if(reviews)sql.append(" AND (i.last_reviewed_at IS NULL OR i.last_reviewed_at<=DATE_SUB(NOW(3),INTERVAL 90 DAY) OR EXISTS (SELECT 1 FROM wb_knowledge_feedback f WHERE f.version_id=v.version_id AND f.value='expired' AND f.event_id>i.reviewed_feedback_id))");
        sql.append(" ORDER BY i.knowledge_id LIMIT ?");args.add(limit);
        return jdbc.query(sql.toString(),(r,i)->itemRow(r),args.toArray());
    }
    public boolean repositoryExists(String workspace,String repo){return jdbc.queryForObject("SELECT COUNT(*) FROM wb_repository WHERE workspace_id=? AND repository_id=?",Long.class,workspace,repo)==1;}
    public boolean activeRepository(String workspace,String repo){return jdbc.queryForObject("SELECT COUNT(*) FROM wb_repository WHERE workspace_id=? AND repository_id=? AND status=1",Long.class,workspace,repo)==1;}
    public record IndexDocument(long rowId,String workspaceId,String knowledgeId,long version,boolean archived,String termKey,String category,String title,String text) {}
    public List<IndexDocument> pendingIndex(long after,int limit){return jdbc.query("SELECT i.*,v.text FROM wb_knowledge_item i JOIN wb_knowledge_version v ON v.version_id=i.current_version_id WHERE i.id>? AND i.indexed_version<i.version ORDER BY i.id LIMIT ?",(r,i)->new IndexDocument(r.getLong("id"),r.getString("workspace_id"),r.getString("knowledge_id"),r.getLong("version"),r.getBoolean("archived"),r.getString("term_key"),r.getString("category"),r.getString("title"),r.getBoolean("archived")?"":r.getString("text")),after,limit);}
    public void markIndexed(IndexDocument doc){jdbc.update("UPDATE wb_knowledge_item SET indexed_version=GREATEST(indexed_version,?) WHERE workspace_id=? AND knowledge_id=?",doc.version(),doc.workspaceId(),doc.knowledgeId());}
    public void requireReference(String workspace,String id,String versionId){if(jdbc.query("SELECT i.knowledge_id FROM wb_knowledge_item i JOIN wb_knowledge_version v ON v.knowledge_id=i.knowledge_id AND v.version_id=? WHERE i.workspace_id=? AND i.knowledge_id=? AND i.archived=0 FOR UPDATE",(r,i)->r.getString(1),versionId,workspace,id).isEmpty())throw new ApiProblem(404,"RESOURCE_NOT_FOUND");}
}
