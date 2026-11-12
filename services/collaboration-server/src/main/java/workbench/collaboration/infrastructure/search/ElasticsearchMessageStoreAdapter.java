package workbench.collaboration.infrastructure.search;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.conversation.Message;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * 模块：Elasticsearch 7.6.0 消息存储与全文检索适配器 (ElasticsearchMessageStoreAdapter)
 *
 * <p>【功能定义】
 * 提供对 Elasticsearch 7.6.0 集群的消息索引写入、点查与全文检索能力。
 *
 * <p>【快速熔断与可用性保障 (Why)】
 * - 配置 OkHttpClient 800 毫秒全局调用超时；
 * - 当 ES 出现网络抖动、宕机或超时时，自动返回 Optional.empty() 进行熔断兜底，
 *   绝不阻塞上游会话流或挂起 Web 工作线程。
 *
 * <p>【协作边界】
 * - 上游调用方：JedisCollaborationState、MiddlewareConfig 检索监听器。
 * - 下游依赖方：OkHttpClient、EsMessageRequests、Jackson JsonMapper。
 */
public final class ElasticsearchMessageStoreAdapter {

    private final EsMessageRequests requests;
    private final OkHttpClient http;
    private final JsonMapper json = JsonMapper.builder().build();

    public ElasticsearchMessageStoreAdapter(String baseUrl) {
        this(new EsMessageRequests(baseUrl), new OkHttpClient.Builder().callTimeout(800, TimeUnit.MILLISECONDS).build());
    }

    public ElasticsearchMessageStoreAdapter(EsMessageRequests requests, OkHttpClient http) {
        this.requests = requests;
        this.http = http;
    }

    /**
     * 自动识别文档类别并写入对应的 ES 索引库。
     */
    public void index(String workspaceId, String documentJson) {
        JsonNode doc = json.readTree(documentJson);
        String messageId = doc.path("messageId").asString("");
        if (!messageId.isEmpty()) {
            execute(requests.index(workspaceId, messageId, documentJson));
            return;
        }
        String conversationId = doc.path("conversationId").asString("");
        if (!conversationId.isEmpty()) {
            execute(requests.indexConversation(workspaceId, conversationId, documentJson));
        }
    }

    /**
     * 根据工作区与消息标识从 ES 实时点查原始 JSON 报文。
     */
    public Optional<String> find(String workspaceId, String messageId) {
        return execute(requests.point(workspaceId, messageId));
    }

    /**
     * 点查单条消息并反序列化为领域 Message 实体。
     */
    public Optional<Message> findMessage(String workspaceId, String messageId) {
        return find(workspaceId, messageId).flatMap(raw -> {
            JsonNode root = json.readTree(raw);
            JsonNode source = root.has("_source") ? root.get("_source") : root;
            if (!source.isObject() || source.path("messageId").asString("").isEmpty()) {
                return Optional.empty();
            }
            return Optional.of(json.treeToValue(source, Message.class));
        });
    }

    public Optional<String> search(String workspaceId, String conversationId) {
        return execute(requests.search(workspaceId, conversationId));
    }

    public Optional<String> search(String workspaceId, String conversationId, Long beforeSequence, String keyword, int limit) {
        return execute(requests.search(workspaceId, conversationId, beforeSequence, keyword, limit));
    }

    /**
     * ES 回源：读取序号大于 afterSequence 的定稿消息（升序，热窗缺段兜底）。
     */
    public List<Message> listAfter(String workspaceId, String conversationId, long afterSequence, int limit) {
        return execute(requests.after(workspaceId, conversationId, afterSequence, limit))
                .map(raw -> {
                    List<Message> found = new ArrayList<>();
                    for (JsonNode hit : json.readTree(raw).path("hits").path("hits")) {
                        JsonNode source = hit.path("_source");
                        if (source.isObject()) {
                            found.add(json.treeToValue(source, Message.class));
                        }
                    }
                    return found;
                })
                .orElse(List.of());
    }

    public EsMessageRequests requests() {
        return requests;
    }

    private Optional<String> execute(Request request) {
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                return Optional.empty();
            }
            return Optional.of(response.body().string());
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    public boolean timedOut(JsonNode error) {
        return error != null && error.path("timed_out").asBoolean(false);
    }
}
