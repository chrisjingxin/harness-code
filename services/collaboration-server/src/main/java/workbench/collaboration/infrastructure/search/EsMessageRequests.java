package workbench.collaboration.infrastructure.search;

import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import tools.jackson.databind.json.JsonMapper;

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
 * 统一定义协作定稿消息（wb_message_v1）与会话索引（wb_conversation_handoff_v1）在 ES 7.6.0 中的 RESTful 请求规范。
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
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    private final String baseUrl;

    public EsMessageRequests(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
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
     * 构造会话交接索引写入请求。
     */
    public Request indexConversation(String workspaceId, String conversationId, String documentJson) {
        return new Request.Builder()
                .url(baseUrl + "/wb_conversation_handoff_v1/_doc/" + encode(conversationId) + "?routing=" + encode(workspaceId))
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
            bool.put("must", List.of(Map.of("match", Map.of("text", keyword))));
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

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
