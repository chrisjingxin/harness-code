package workbench.collaboration.infrastructure.search;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.interfaces.ApiProblem;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * 模块：Elasticsearch 7.6.0 消息存储与全文检索适配器 (ElasticsearchMessageStoreAdapter)
 *
 * <p>【功能定义】
 * 提供对 Elasticsearch 7.6.0 集群的索引初始化探活、批量持久化写入、实时点查与历史回源能力。
 *
 * <p>【可靠性与实时性保障 (Why)】
 * - 启动期由 ensureReady() 强探活并幂等创建 wb_message_v1 / wb_conversation_v1 / wb_knowledge_v1 显式 Mapping；
 * - 消息写入（saveMessages）与历史回源（readAfterStrict）采用 Fail-Closed 策略：发生超时或非 2xx 错误时
 *   记录日志并抛出 503 SERVICE_UNAVAILABLE，杜绝静默丢消息或虚推客户端水位；
 * - 回源优先按确定性 ID 走 _mget 直读 Translog（0 延迟可见，规避 ES 1s refresh_interval 盲区）。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig、JedisCollaborationState、KnowledgeAppService、KnowledgeIndexProjection。
 * - 下游依赖方：OkHttpClient、EsMessageRequests、Jackson JsonMapper。
 */
public final class ElasticsearchMessageStoreAdapter {

    private static final Logger LOGGER = LoggerFactory.getLogger(ElasticsearchMessageStoreAdapter.class);
    private static final int MAX_STRICT_PAGE_SIZE = 500;

    private final EsMessageRequests requests;
    private final OkHttpClient http;
    private final JsonMapper json = JsonMapper.builder().build();

    public ElasticsearchMessageStoreAdapter(String baseUrl) {
        this(new EsMessageRequests(baseUrl), new OkHttpClient.Builder().callTimeout(2000, TimeUnit.MILLISECONDS).build());
    }

    public ElasticsearchMessageStoreAdapter(EsMessageRequests requests, OkHttpClient http) {
        this.requests = requests;
        this.http = http;
    }

    /**
     * 启动期探测 Elasticsearch 连通性，并幂等创建必需索引与显式 Mapping。
     * 不可达或建索引失败时直接抛出 IllegalStateException 阻止服务带病启动。
     */
    public void ensureReady() {
        OkHttpClient startupClient = http.newBuilder()
                .callTimeout(Math.max(http.callTimeoutMillis(), 5000), TimeUnit.MILLISECONDS)
                .build();
        try (Response response = startupClient.newCall(requests.ping()).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IllegalStateException("Elasticsearch 健康探测失败: HTTP " + response.code());
            }
            JsonNode root = json.readTree(response.body().string());
            String version = root.path("version").path("number").asString("unknown");
            String clusterName = root.path("cluster_name").asString("unknown");
            LOGGER.info("Elasticsearch 已连接: cluster={}, version={}", clusterName, version);
        } catch (IOException failure) {
            throw new IllegalStateException("Elasticsearch 不可达，拒绝以 cluster 模式启动: " + failure.getMessage(), failure);
        }

        for (Map.Entry<String, String> entry : EsMessageRequests.indexMappings().entrySet()) {
            String index = entry.getKey();
            String mapping = entry.getValue();
            try (Response head = startupClient.newCall(requests.headIndex(index)).execute()) {
                if (head.code() == 200) {
                    continue;
                }
                if (head.code() != 404) {
                    throw new IllegalStateException("检查 Elasticsearch 索引状态失败: " + index + " HTTP " + head.code());
                }
            } catch (IOException failure) {
                throw new IllegalStateException("检查 Elasticsearch 索引失败: " + index, failure);
            }

            try (Response created = startupClient.newCall(requests.createIndex(index, mapping)).execute()) {
                if (created.isSuccessful()) {
                    LOGGER.info("已自动创建 Elasticsearch 索引与显式 Mapping: {}", index);
                    continue;
                }
                String body = created.body() == null ? "" : created.body().string();
                if (created.code() == 400 && body.contains("resource_already_exists_exception")) {
                    continue;
                }
                throw new IllegalStateException("创建 Elasticsearch 索引失败: " + index + " HTTP " + created.code() + " " + body);
            } catch (IOException failure) {
                throw new IllegalStateException("创建 Elasticsearch 索引失败: " + index, failure);
            }
        }
    }

    /**
     * 严格批量持久化写入定稿消息。任何网络失败、超时或子项报错均抛出 503 SERVICE_UNAVAILABLE。
     */
    public void saveMessages(String workspaceId, List<Message> batch) {
        if (batch == null || batch.isEmpty()) {
            return;
        }
        Request request = requests.bulkIndexMessages(workspaceId, batch);
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                String body = response.body() == null ? "" : response.body().string();
                LOGGER.error("Elasticsearch 批量写入定稿消息失败 (workspace={}, count={}, http={}): {}",
                        workspaceId, batch.size(), response.code(), body);
                throw searchUnavailable();
            }
            JsonNode result = json.readTree(response.body().string());
            if (result.path("errors").asBoolean(true)) {
                LOGGER.error("Elasticsearch 批量写入返回部分子项错误 (workspace={}, count={}, items={})",
                        workspaceId, batch.size(), result.path("items").toString());
                throw searchUnavailable();
            }
        } catch (IOException failure) {
            LOGGER.error("Elasticsearch 批量写入通信失败 (workspace={}, count={}): {}",
                    workspaceId, batch.size(), failure.getMessage());
            throw searchUnavailable();
        }
    }

    /**
     * 严格读取序号大于 afterSequence 的连续定稿消息。
     * 优先按确定性 messageId 走 _mget 直读 Translog（0 延迟），首条未命中时严格回退 _search。
     * 任何网络异常、超时或分片失败均抛出 503 SERVICE_UNAVAILABLE。
     */
    public List<Message> readAfterStrict(String workspaceId, String conversationId, long afterSequence, int limit) {
        if (limit <= 0) {
            return List.of();
        }
        int pageLimit = Math.min(limit, MAX_STRICT_PAGE_SIZE);
        List<String> ids = new ArrayList<>(pageLimit);
        for (int i = 1; i <= pageLimit; i++) {
            ids.add(Message.deterministicId(conversationId, afterSequence + i));
        }
        try (Response response = http.newCall(requests.mgetMessages(workspaceId, ids)).execute()) {
            if (response.code() == 404) {
                return List.of();
            }
            if (!response.isSuccessful() || response.body() == null) {
                LOGGER.error("Elasticsearch _mget 回源失败 (workspace={}, conversation={}, http={})",
                        workspaceId, conversationId, response.code());
                throw searchUnavailable();
            }
            JsonNode root = json.readTree(response.body().string());
            JsonNode docs = root.path("docs");
            if (!docs.isArray()) {
                LOGGER.error("Elasticsearch _mget 响应格式异常 (workspace={}, conversation={})", workspaceId, conversationId);
                throw searchUnavailable();
            }
            List<Message> found = new ArrayList<>();
            for (int i = 0; i < docs.size(); i++) {
                JsonNode doc = docs.get(i);
                if (!doc.path("error").isMissingNode() && !doc.path("error").isNull()) {
                    LOGGER.error("Elasticsearch _mget 返回文档错误 (workspace={}, conversation={}): {}",
                            workspaceId, conversationId, doc.path("error").toString());
                    throw searchUnavailable();
                }
                if (!doc.path("found").asBoolean(false)) {
                    if (i == 0) {
                        return readAfterBySearchStrict(workspaceId, conversationId, afterSequence, pageLimit);
                    }
                    break;
                }
                JsonNode source = doc.path("_source");
                if (!source.isObject()) {
                    throw searchUnavailable();
                }
                Message message = json.treeToValue(source, Message.class);
                long expectedSequence = afterSequence + i + 1L;
                if (!workspaceId.equals(message.workspaceId())
                        || !conversationId.equals(message.conversationId())
                        || message.sequence() != expectedSequence) {
                    LOGGER.error("Elasticsearch _mget 文档元数据校验不一致 (expectedSeq={}, actualSeq={}, conv={})",
                            expectedSequence, message.sequence(), conversationId);
                    throw searchUnavailable();
                }
                found.add(message);
            }
            return found;
        } catch (IOException failure) {
            LOGGER.error("Elasticsearch _mget 回源通信失败 (workspace={}, conversation={}): {}",
                    workspaceId, conversationId, failure.getMessage());
            throw searchUnavailable();
        }
    }

    private List<Message> readAfterBySearchStrict(String workspaceId, String conversationId, long afterSequence, int limit) {
        try (Response response = http.newCall(requests.after(workspaceId, conversationId, afterSequence, limit)).execute()) {
            if (response.code() == 404) {
                return List.of();
            }
            if (!response.isSuccessful() || response.body() == null) {
                LOGGER.error("Elasticsearch _search 回源失败 (workspace={}, conversation={}, http={})",
                        workspaceId, conversationId, response.code());
                throw searchUnavailable();
            }
            JsonNode result = json.readTree(response.body().string());
            if (result.path("timed_out").asBoolean(false) || result.path("_shards").path("failed").asInt(0) > 0) {
                LOGGER.error("Elasticsearch _search 回源超时或分片失败 (workspace={}, conversation={})",
                        workspaceId, conversationId);
                throw searchUnavailable();
            }
            List<Message> found = new ArrayList<>();
            for (JsonNode hit : result.path("hits").path("hits")) {
                JsonNode source = hit.path("_source");
                if (source.isObject()) {
                    found.add(json.treeToValue(source, Message.class));
                }
            }
            return found;
        } catch (IOException failure) {
            LOGGER.error("Elasticsearch _search 回源通信失败 (workspace={}, conversation={}): {}",
                    workspaceId, conversationId, failure.getMessage());
            throw searchUnavailable();
        }
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

    public record KnowledgeHit(String id, long version) {}

    public boolean indexKnowledge(String workspaceId, String knowledgeId, long version, Object document) {
        var request = requests.indexKnowledge(workspaceId, knowledgeId, version, json.writeValueAsString(document));
        try (Response response = http.newCall(request).execute()) {
            // 409 表示该文档已写入更新版本，该旧版本无需再投影。
            return response.isSuccessful() || response.code() == 409;
        } catch (IOException failure) {
            return false;
        }
    }

    public List<KnowledgeHit> searchKnowledge(String workspaceId, String category, String query, String afterId, int limit) {
        Request request = requests.searchKnowledge(workspaceId, category, query, afterId, limit);
        try (Response response = http.newCall(request).execute()) {
            if (response.code() == 404) return List.of(); // 新建团队尚未写第一份索引
            if (!response.isSuccessful() || response.body() == null) throw searchUnavailable();
            JsonNode result = json.readTree(response.body().string());
            if (result.path("timed_out").asBoolean(false) || result.path("_shards").path("failed").asInt(0) > 0) {
                throw searchUnavailable();
            }
            List<KnowledgeHit> hits = new ArrayList<>();
            for (JsonNode hit : result.path("hits").path("hits")) {
                JsonNode source = hit.path("_source");
                hits.add(new KnowledgeHit(source.path("knowledgeId").asString(), source.path("version").asLong()));
            }
            return hits;
        } catch (IOException failure) {
            throw searchUnavailable();
        }
    }

    private static ApiProblem searchUnavailable() {
        return new ApiProblem(503, "SERVICE_UNAVAILABLE");
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
