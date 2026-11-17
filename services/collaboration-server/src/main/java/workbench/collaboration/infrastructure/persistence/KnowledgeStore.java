package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.interfaces.ApiProblem;

import javax.sql.DataSource;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static workbench.collaboration.interfaces.dto.KnowledgeDtos.*;

/** 知识条目保存术语键和当前版本，正文只写入不可变版本表。 */
@Repository
public class KnowledgeStore {
    private static final RowMapper<KnowledgeSummary> ITEM = (row, index) -> new KnowledgeSummary(
            row.getString("knowledge_id"), row.getString("term_key"), row.getString("category"), row.getString("title"),
            row.getString("current_version_id"), row.getLong("version"), row.getBoolean("archived"),
            Times.ms(row.getObject("updated_at", LocalDateTime.class)));
    private static final RowMapper<KnowledgeVersionSummary> VERSION = (row, index) -> new KnowledgeVersionSummary(
            row.getString("version_id"), row.getLong("version"), row.getString("category"), row.getString("title"),
            row.getString("author_id"), Times.ms(row.getObject("created_at", LocalDateTime.class)));
    private final JdbcTemplate jdbc;

    public KnowledgeStore(DataSource dataSource) {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    public void insert(String workspace, KnowledgeSummary item) {
        jdbc.update("""
                INSERT INTO wb_knowledge_item (workspace_id, knowledge_id, term_key, category, title,
                                               current_version_id, version, archived, updated_at)
                VALUES (?,?,?,?,?,?,1,0,?)
                """, workspace, item.knowledgeId(), item.termKey(), item.category(), item.title(),
                item.currentVersionId(), Times.ofMs(item.updatedAtMs()));
    }

    public void append(String id, KnowledgeVersionSummary version, String text) {
        jdbc.update("""
                INSERT INTO wb_knowledge_version (knowledge_id, version_id, version, category, title, author_id, text, created_at)
                VALUES (?,?,?,?,?,?,?,?)
                """, id, version.versionId(), version.version(), version.category(), version.title(),
                version.authorId(), text, Times.ofMs(version.createdAtMs()));
    }

    public Optional<KnowledgeSummary> find(String workspace, String id) {
        return jdbc.query("SELECT * FROM wb_knowledge_item WHERE workspace_id=? AND knowledge_id=?",
                ITEM, workspace, id).stream().findFirst();
    }

    public boolean update(String workspace, KnowledgeSummary item, long expectedVersion) {
        return jdbc.update("""
                UPDATE wb_knowledge_item SET category=?, title=?, current_version_id=?, version=version+1,
                                             archived=?, updated_at=?
                WHERE workspace_id=? AND knowledge_id=? AND version=? AND archived=0
                """, item.category(), item.title(), item.currentVersionId(), item.archived(), Times.ofMs(item.updatedAtMs()),
                workspace, item.knowledgeId(), expectedVersion) == 1;
    }

    /** 读一份固定材料。条目团队资格由上游校验，版本查询仍限定在该条目。 */
    public Optional<KnowledgeVersion> version(KnowledgeSummary item, String versionId) {
        return jdbc.query("SELECT * FROM wb_knowledge_version WHERE knowledge_id=? AND version_id=?",
                (row, index) -> new KnowledgeVersion(item.knowledgeId(), item.termKey(), item.archived(),
                        VERSION.mapRow(row, index), row.getString("text")), item.knowledgeId(), versionId).stream().findFirst();
    }

    public List<KnowledgeVersionSummary> versions(String id, String afterId, int limit) {
        return jdbc.query("""
                SELECT * FROM wb_knowledge_version WHERE knowledge_id=?
                  AND (?='' OR version < (SELECT v.version FROM wb_knowledge_version v
                                          WHERE v.knowledge_id=? AND v.version_id=?))
                ORDER BY version DESC LIMIT ?
                """, VERSION, id, afterId, id, afterId, limit);
    }

    public List<KnowledgeSummary> list(String workspace, String category, String query, String afterId, int limit) {
        return jdbc.query("""
                SELECT i.* FROM wb_knowledge_item i
                JOIN wb_knowledge_version v ON v.version_id=i.current_version_id
                WHERE i.workspace_id=? AND i.knowledge_id>? AND i.archived=0
                  AND (? IS NULL OR i.category COLLATE utf8mb4_bin=?)
                  AND (? IS NULL OR LOCATE(?, CONCAT_WS(' ',i.term_key,i.title,v.text))>0)
                ORDER BY i.knowledge_id LIMIT ?
                """, ITEM, workspace, afterId, category, category, query, query, limit);
    }

    /** 待投影条目可在节点重启后从数据库重新枚举。 */
    public record IndexDocument(long rowId, String workspaceId, String knowledgeId, long version, boolean archived,
                                String termKey, String category, String title, String text) {}

    public List<IndexDocument> pendingIndex(long afterRowId, int limit) {
        return jdbc.query("""
                SELECT i.*, v.text FROM wb_knowledge_item i
                JOIN wb_knowledge_version v ON v.version_id=i.current_version_id
                WHERE i.id>? AND i.indexed_version < i.version ORDER BY i.id LIMIT ?
                """, (row, index) -> new IndexDocument(row.getLong("id"), row.getString("workspace_id"), row.getString("knowledge_id"),
                row.getLong("version"), row.getBoolean("archived"), row.getString("term_key"),
                row.getString("category"), row.getString("title"), row.getBoolean("archived") ? "" : row.getString("text")),
                afterRowId, limit);
    }

    public void markIndexed(IndexDocument document) {
        jdbc.update("""
                UPDATE wb_knowledge_item SET indexed_version=GREATEST(indexed_version,?)
                WHERE workspace_id=? AND knowledge_id=?
                """, document.version(), document.workspaceId(), document.knowledgeId());
    }

    /** 任务保存时锁定引用条目，归档和新引用按同一条目行的提交顺序生效。 */
    public void requireReference(String workspace, String id, String versionId) {
        boolean exists = !jdbc.query("""
                SELECT i.knowledge_id FROM wb_knowledge_item i
                JOIN wb_knowledge_version v ON v.knowledge_id=i.knowledge_id AND v.version_id=?
                WHERE i.workspace_id=? AND i.knowledge_id=? AND i.archived=0 FOR UPDATE
                """, (row, index) -> row.getString(1), versionId, workspace, id).isEmpty();
        if (!exists) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
    }
}
