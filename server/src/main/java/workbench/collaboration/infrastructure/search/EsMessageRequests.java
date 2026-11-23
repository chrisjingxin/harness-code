package workbench.collaboration.infrastructure.search;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.conversation.Message;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 模块：Elasticsearch 7.6.0 REST 请求构造器 (EsMessageRequests)
 *
 * <p>【功能定义】
 * 统一定义协作定稿消息（wb_message_v1）与会话索引（wb_conversation_v1）在 ES 7.6.0 中的 RESTful 请求规范。
 *
 * <p>【架构不变量与兼容性约束 (Invariants)】
 * 1. 单分片路由隔离（routing=workspaceId）：所有文档写入、点查与检索必须显式携带 routing 参数，
 *    确保同工作区数据聚簇在同一物理分片上，消除高并发下的跨分片广播扫描；
 * 2. 兼容性参数：检索请求统一追加 rest_total_hits_as_int=true，确保返回整型命中数而非 7.x+ 的对象结构；
 * 3. 严格服务端超时（timeout: 800ms）：检索 DSL 中强制植入 800 毫秒服务端中断超时，防止慢查询拖垮集群。
 *
 * <p>【协作边界】
 * - 上游调用方：ElasticsearchMessageStoreAdapter。
 * - 下游依赖方：OkHttp3 Request 构建体系、Jackson JsonMapper。
 */
public final class EsMessageRequests {

    private static final MediaType JSON = MediaType.get("application/json");
    private static final MediaType NDJSON = MediaType.get("application/x-ndjson");
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    public static final String MESSAGE_INDEX = "wb_message_v1";
    public static final String CONVERSATION_INDEX = "wb_conversation_v1";
    public static final String KNOWLEDGE_INDEX = "wb_knowledge_v1";

    private final String baseUrl;

    public EsMessageRequests(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    /** 探测 Elasticsearch 根端点连通性与版本信息。 */
    public Request ping() {
        return new Request.Builder()
                .url(baseUrl + "/")
                .get()
                .build();
    }

    /** 检查指定索引是否已存在。 */
    public Request headIndex(String index) {
        return new Request.Builder()
                .url(baseUrl + "/" + encode(index))
                .head()
                .build();
    }

    /** 创建索引并显式声明分片与字段 Mapping。 */
    public Request createIndex(String index, String mappingJson) {
        return new Request.Builder()
                .url(baseUrl + "/" + encode(index))
                .put(RequestBody.create(mappingJson, JSON))
                .build();
    }

    /**
     * 构造批量写入定稿消息的 ES _bulk 请求（NDJSON）。
     */
    public Request bulkIndexMessages(String workspaceId, List<Message> messages) {
        StringBuilder ndjson = new StringBuilder();
        for (Message message : messages) {
            ndjson.append(MAPPER.writeValueAsString(Map.of(
                    "index", Map.of("_id", message.messageId(), "routing", workspaceId))))
                    .append('\n')
                    .append(MAPPER.writeValueAsString(message))
                    .append('\n');
        }
        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_bulk?routing=" + encode(workspaceId))
                .post(RequestBody.create(ndjson.toString(), NDJSON))
                .build();
    }

    /**
     * 构造按确定性消息 ID 批量实时点查的 ES _mget 请求（直读 Translog，0 延迟可见）。
     */
    public Request mgetMessages(String workspaceId, List<String> messageIds) {
        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_mget?routing=" + encode(workspaceId))
                .post(RequestBody.create(MAPPER.writeValueAsString(Map.of("ids", messageIds)), JSON))
                .build();
    }

    /**
     * 构造单条消息点查请求（基于 Translog 实现 0 延迟实时点查）。
     */
    public Request point(String workspaceId, String messageId) {
        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_doc/" + encode(messageId) + "?routing=" + encode(workspaceId))
                .get()
                .build();
    }

    /**
     * 构造定稿消息持久化写入请求。
     */
    public Request index(String workspaceId, String messageId, String documentJson) {
        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_doc/" + encode(messageId) + "?routing=" + encode(workspaceId))
                .put(RequestBody.create(documentJson, JSON))
                .build();
    }

    /**
     * 构造会话简报索引写入请求。
     */
    public Request indexConversation(String workspaceId, String conversationId, String documentJson) {
        return new Request.Builder()
                .url(baseUrl + "/wb_conversation_v1/_doc/" + encode(conversationId) + "?routing=" + encode(workspaceId))
                .put(RequestBody.create(documentJson, JSON))
                .build();
    }

    /**
     * 构造单会话内简单 term 检索请求。
     */
    public Request search(String workspaceId, String conversationId) {
        Map<String, Object> dsl = new LinkedHashMap<>();
        dsl.put("timeout", "800ms");
        dsl.put("query", Map.of("term", Map.of("conversationId", conversationId)));
        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_search?routing=" + encode(workspaceId) + "&rest_total_hits_as_int=true")
                .post(RequestBody.create(MAPPER.writeValueAsString(dsl), JSON))
                .build();
    }

    /**
     * 构造支持按序号游标翻页（sequence < beforeSequence）及同工作区全文关键词检索的高级 DSL 请求。
     */
    public Request search(String workspaceId, String conversationId, Long beforeSequence, String keyword, int limit) {
        List<Object> filters = new ArrayList<>();
        filters.add(Map.of("term", Map.of("workspaceId", workspaceId)));
        if (conversationId != null && !conversationId.isEmpty()) {
            filters.add(Map.of("term", Map.of("conversationId", conversationId)));
        }
        if (beforeSequence != null) {
            filters.add(Map.of("range", Map.of("sequence", Map.of("lt", beforeSequence))));
        }

        Map<String, Object> bool = new LinkedHashMap<>();
        bool.put("filter", filters);
        if (keyword != null && !keyword.isBlank()) {
            bool.put("must", List.of(Map.of("match", Map.of("payload", keyword))));
        }

        Map<String, Object> dsl = new LinkedHashMap<>();
        dsl.put("timeout", "800ms");
        dsl.put("size", Math.max(1, Math.min(limit, 200)));
        dsl.put("sort", List.of(Map.of("sequence", Map.of("order", "desc"))));
        dsl.put("query", Map.of("bool", bool));

        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_search?routing=" + encode(workspaceId) + "&rest_total_hits_as_int=true")
                .post(RequestBody.create(MAPPER.writeValueAsString(dsl), JSON))
                .build();
    }

    /**
     * 构造按序号正向翻页（sequence > afterSequence）的只读增量历史请求。
     * 热窗缺段时由 MessageStorePort.after 回源调用。
     */
    public Request after(String workspaceId, String conversationId, long afterSequence, int limit) {
        List<Object> filters = new ArrayList<>();
        filters.add(Map.of("term", Map.of("workspaceId", workspaceId)));
        filters.add(Map.of("term", Map.of("conversationId", conversationId)));
        filters.add(Map.of("range", Map.of("sequence", Map.of("gt", afterSequence))));

        Map<String, Object> dsl = new LinkedHashMap<>();
        dsl.put("timeout", "800ms");
        dsl.put("size", Math.max(1, Math.min(limit, 500)));
        dsl.put("sort", List.of(Map.of("sequence", Map.of("order", "asc"))));
        dsl.put("query", Map.of("bool", Map.of("filter", filters)));

        return new Request.Builder()
                .url(baseUrl + "/wb_message_v1/_search?routing=" + encode(workspaceId) + "&rest_total_hits_as_int=true")
                .post(RequestBody.create(MAPPER.writeValueAsString(dsl), JSON))
                .build();
    }

    /** 索引只接收已提交的版本。外部版本号防止并行投影用旧正文覆盖新正文。 */
    public Request indexKnowledge(String workspaceId, String knowledgeId, long version, String documentJson) {
        return new Request.Builder()
                .url(baseUrl + "/wb_knowledge_v1/_doc/" + encode(knowledgeId) + "?routing=" + encode(workspaceId)
                        + "&version_type=external_gte&version=" + version)
                .put(RequestBody.create(documentJson, JSON))
                .build();
    }

    /** 术语前缀匹配与标题正文搜索并用，返回按知识 ID 排序的候选。 */
    public Request searchKnowledge(String workspaceId, String category, String keyword, String afterId, int limit) {
        List<Object> filters = new ArrayList<>();
        filters.add(Map.of("term", Map.of("workspaceId.keyword", workspaceId)));
        filters.add(Map.of("term", Map.of("archived", false)));
        if (category != null) filters.add(Map.of("term", Map.of("category.keyword", category)));
        List<Object> matches = List.of(
                Map.of("prefix", Map.of("termKey.keyword", keyword.toLowerCase(java.util.Locale.ROOT))),
                Map.of("multi_match", Map.of("query", keyword, "fields", List.of("title", "text"))));
        Map<String, Object> dsl = new LinkedHashMap<>();
        dsl.put("timeout", "800ms");
        dsl.put("size", limit);
        dsl.put("_source", List.of("knowledgeId", "version"));
        dsl.put("sort", List.of(Map.of("knowledgeId.keyword", "asc")));
        if (!afterId.isEmpty()) dsl.put("search_after", List.of(afterId));
        dsl.put("query", Map.of("bool", Map.of("filter", filters, "should", matches, "minimum_should_match", 1)));
        return new Request.Builder()
                .url(baseUrl + "/wb_knowledge_v1/_search?routing=" + encode(workspaceId))
                .post(RequestBody.create(MAPPER.writeValueAsString(dsl), JSON))
                .build();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    /**
     * 声明 cluster 模式必需的三张 ES 7.6.0 索引 Mapping。
     * 所有 UUID/状态字段显式绑定 keyword，避免动态映射分词导致 term 回源查空。
     */
    public static Map<String, String> indexMappings() {
        Map<String, String> schemas = new LinkedHashMap<>();
        schemas.put(MESSAGE_INDEX, schemaJson(Map.ofEntries(
                Map.entry("messageId", Map.of("type", "keyword")),
                Map.entry("workspaceId", Map.of("type", "keyword")),
                Map.entry("conversationId", Map.of("type", "keyword")),
                Map.entry("type", Map.of("type", "keyword")),
                Map.entry("sequence", Map.of("type", "long")),
                Map.entry("occurredAtMs", Map.of("type", "long")),
                Map.entry("payload", Map.of("type", "text"))
        )));
        schemas.put(CONVERSATION_INDEX, schemaJson(Map.ofEntries(
                Map.entry("conversationId", Map.of("type", "keyword")),
                Map.entry("projectId", Map.of("type", "keyword")),
                Map.entry("ownerUserId", Map.of("type", "keyword")),
                Map.entry("status", Map.of("type", "keyword")),
                Map.entry("briefSource", Map.of("type", "keyword")),
                Map.entry("shareMode", Map.of("type", "keyword")),
                Map.entry("shareStatus", Map.of("type", "keyword")),
                Map.entry("title", textWithKeyword()),
                Map.entry("briefText", Map.of("type", "text")),
                Map.entry("briefUpdatedAtMs", Map.of("type", "long")),
                Map.entry("syncedSequence", Map.of("type", "long")),
                Map.entry("updatedAtMs", Map.of("type", "long"))
        )));
        schemas.put(KNOWLEDGE_INDEX, schemaJson(Map.ofEntries(
                Map.entry("workspaceId", textWithKeyword()),
                Map.entry("knowledgeId", textWithKeyword()),
                Map.entry("termKey", textWithKeyword()),
                Map.entry("category", textWithKeyword()),
                Map.entry("version", Map.of("type", "long")),
                Map.entry("archived", Map.of("type", "boolean")),
                Map.entry("title", Map.of("type", "text")),
                Map.entry("text", Map.of("type", "text"))
        )));
        return schemas;
    }

    private static Map<String, Object> textWithKeyword() {
        return Map.of(
                "type", "text",
                "fields", Map.of("keyword", Map.of("type", "keyword", "ignore_above", 256))
        );
    }

    private static String schemaJson(Map<String, Object> properties) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("settings", Map.of("number_of_shards", 1, "number_of_replicas", 0));
        body.put("mappings", Map.of(
                "_routing", Map.of("required", true),
                "properties", properties
        ));
        return MAPPER.writeValueAsString(body);
    }
}
