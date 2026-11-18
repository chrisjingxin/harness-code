package workbench.collaboration.infrastructure.search;

import com.sun.net.httpserver.HttpServer;
import okhttp3.OkHttpClient;
import okio.Buffer;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.interfaces.ApiProblem;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 查询路径按 ES 7.6.0 固定 routing 和整型命中数。超时或连不上时返回空。 */
class ElasticsearchRequestTest {
  @Test
  void pointAndSearchCarryRoutingAndTheIntegerHitFlag() throws Exception {
    EsMessageRequests requests = new EsMessageRequests("http://127.0.0.1:9200/");
    String workspaceId = "22222222-2222-4222-8222-222222222222";
    String messageId = "66666666-6666-4666-8666-666666666666";
    var point = requests.point(workspaceId, messageId);
    assertThat(point.method()).isEqualTo("GET");
    assertThat(point.url().toString()).isEqualTo("http://127.0.0.1:9200/wb_message_v1/_doc/" + messageId + "?routing=" + workspaceId);
    var index = requests.index(workspaceId, messageId, "{\"messageId\":\"" + messageId + "\"}");
    assertThat(index.method()).isEqualTo("PUT");
    assertThat(index.url().encodedPath()).isEqualTo("/wb_message_v1/_doc/" + messageId);
    assertThat(index.url().queryParameter("routing")).isEqualTo(workspaceId);
    var search = requests.search(workspaceId, "conv");
    assertThat(search.url().toString()).contains("/wb_message_v1/_search").contains("routing=" + workspaceId).contains("rest_total_hits_as_int=true");
    Buffer body = new Buffer();
    search.body().writeTo(body);
    assertThat(body.readUtf8()).contains("\"timeout\":\"800ms\"").contains("\"conversationId\":\"conv\"");

    var convIndex = requests.indexConversation(workspaceId, "conv-1", "{\"conversationId\":\"conv-1\"}");
    assertThat(convIndex.url().encodedPath()).isEqualTo("/wb_conversation_v1/_doc/conv-1");
    assertThat(convIndex.url().queryParameter("routing")).isEqualTo(workspaceId);

    var filtered = requests.search(workspaceId, "conv\"quote", 99L, "key\"word", 25);
    Buffer filteredBody = new Buffer();
    filtered.body().writeTo(filteredBody);
    String encoded = filteredBody.readUtf8();
    assertThat(encoded).contains("\"lt\":99").contains("conv\\\"quote").contains("key\\\"word").contains("\"size\":25").contains("\"payload\"");
  }

  @Test
  void knowledgeIndexFencesStaleVersionsAndSearchScopesCandidates() throws Exception {
    var requests = new EsMessageRequests("http://127.0.0.1:9200");
    var write = requests.indexKnowledge("workspace", "knowledge", 4, "{}");
    assertThat(write.url().encodedPath()).isEqualTo("/wb_knowledge_v1/_doc/knowledge");
    assertThat(write.url().queryParameter("routing")).isEqualTo("workspace");
    assertThat(write.url().queryParameter("version_type")).isEqualTo("external_gte");
    assertThat(write.url().queryParameter("version")).isEqualTo("4");

    var query = requests.searchKnowledge("workspace", "术语", "Billing", "after", 20);
    Buffer body = new Buffer();
    query.body().writeTo(body);
    assertThat(query.url().queryParameter("routing")).isEqualTo("workspace");
    assertThat(body.readUtf8()).contains("\"workspaceId.keyword\":\"workspace\"",
            "\"category.keyword\":\"术语\"", "\"archived\":false",
            "\"termKey.keyword\":\"billing\"", "\"search_after\":[\"after\"]");
  }

  @Test
  void unreachableClusterReturnsEmptyWithinTheFuse() {
    OkHttpClient http = new OkHttpClient.Builder().callTimeout(800, TimeUnit.MILLISECONDS).build();
    var adapter = new ElasticsearchMessageStoreAdapter(new EsMessageRequests("http://192.0.2.1:9"), http);
    long started = System.nanoTime();
    assertThat(adapter.find("22222222-2222-4222-8222-222222222222", "66666666-6666-4666-8666-666666666666")).isEmpty();
    assertThat(System.nanoTime() - started).isLessThan(1_500_000_000L);
    adapter.index("22222222-2222-4222-8222-222222222222", "{\"title\":\"no message id\"}");
  }

  @Test
  void ensureReadyBulkSaveAndMgetReadStrictlyPreserveOrderAndFailClosed() throws Exception {
    JsonMapper mapper = JsonMapper.builder().build();
    Set<String> indices = ConcurrentHashMap.newKeySet();
    Map<String, String> indexMappings = new ConcurrentHashMap<>();
    Map<String, Message> stored = new ConcurrentHashMap<>();
    AtomicInteger failBulkStatus = new AtomicInteger(0);
    AtomicInteger failMgetStatus = new AtomicInteger(0);
    AtomicInteger bulkSubItemError = new AtomicInteger(0);

    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/", exchange -> {
      String path = exchange.getRequestURI().getPath();
      String method = exchange.getRequestMethod();
      String reqBody = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      if ("/".equals(path) && "GET".equals(method)) {
        respond(exchange, 200, "{\"cluster_name\":\"test-es\",\"version\":{\"number\":\"7.6.0\"}}");
        return;
      }
      if (path.matches("/wb_(message|conversation|knowledge)_v1")) {
        String index = path.substring(1);
        if ("HEAD".equals(method)) {
          exchange.sendResponseHeaders(indices.contains(index) ? 200 : 404, -1);
          exchange.close();
          return;
        }
        if ("PUT".equals(method)) {
          indexMappings.put(index, reqBody);
          if (indices.add(index)) {
            respond(exchange, 200, "{\"acknowledged\":true}");
          } else {
            respond(exchange, 400, "{\"error\":{\"type\":\"resource_already_exists_exception\"}}");
          }
          return;
        }
      }
      if ("/wb_message_v1/_bulk".equals(path) && "POST".equals(method)) {
        int status = failBulkStatus.get();
        if (status > 0) {
          respond(exchange, status, "{\"error\":\"boom\"}");
          return;
        }
        if (bulkSubItemError.get() > 0) {
          respond(exchange, 200, "{\"errors\":true,\"items\":[{\"index\":{\"status\":400}}]}");
          return;
        }
        String[] lines = reqBody.split("\n");
        for (int i = 0; i + 1 < lines.length; i += 2) {
          Message msg = mapper.readValue(lines[i + 1], Message.class);
          stored.put(msg.messageId(), msg);
        }
        respond(exchange, 200, "{\"errors\":false,\"items\":[]}");
        return;
      }
      if ("/wb_message_v1/_mget".equals(path) && "POST".equals(method)) {
        int status = failMgetStatus.get();
        if (status > 0) {
          respond(exchange, status, "{\"error\":\"boom\"}");
          return;
        }
        JsonNode root = mapper.readTree(reqBody);
        List<Map<String, Object>> docs = new java.util.ArrayList<>();
        for (JsonNode idNode : root.path("ids")) {
          String id = idNode.asString();
          Message msg = stored.get(id);
          if (msg == null) {
            docs.add(Map.of("_id", id, "found", false));
          } else {
            docs.add(Map.of("_id", id, "found", true, "_source", msg));
          }
        }
        respond(exchange, 200, mapper.writeValueAsString(Map.of("docs", docs)));
        return;
      }
      if ("/wb_message_v1/_search".equals(path) && "POST".equals(method)) {
        respond(exchange, 200, "{\"timed_out\":false,\"_shards\":{\"failed\":0},\"hits\":{\"hits\":[]}}");
        return;
      }
      respond(exchange, 404, "{}");
    });
    server.start();
    try {
      String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
      ElasticsearchMessageStoreAdapter adapter = new ElasticsearchMessageStoreAdapter(baseUrl);

      adapter.ensureReady();
      // 重复执行必须幂等，不失败
      adapter.ensureReady();
      assertThat(indices).containsExactlyInAnyOrder("wb_message_v1", "wb_conversation_v1", "wb_knowledge_v1");
      assertThat(indexMappings.get("wb_message_v1")).contains("\"_routing\":{\"required\":true}")
              .contains("\"conversationId\":{\"type\":\"keyword\"}")
              .contains("\"payload\":{\"type\":\"text\"}");

      String ws = "22222222-2222-4222-8222-222222222222";
      String conv = "88888888-8888-4888-8888-888888888888";
      List<Message> batch = List.of(
              new Message(Message.deterministicId(conv, 1), ws, conv, "user", 1, "{\"text\":\"q1\"}", 100L),
              new Message(Message.deterministicId(conv, 2), ws, conv, "assistant", 2, "{\"text\":\"a1\"}", 101L)
      );
      adapter.saveMessages(ws, batch);

      List<Message> read = adapter.readAfterStrict(ws, conv, 0, 10);
      assertThat(read).hasSize(2);
      assertThat(read.get(0).sequence()).isEqualTo(1L);
      assertThat(read.get(1).sequence()).isEqualTo(2L);
      assertThat(adapter.readAfterStrict(ws, conv, 2, 10)).isEmpty();

      failBulkStatus.set(500);
      assertThatThrownBy(() -> adapter.saveMessages(ws, batch))
              .isInstanceOf(ApiProblem.class)
              .extracting("status", "code")
              .containsExactly(503, "SERVICE_UNAVAILABLE");
      failBulkStatus.set(0);

      bulkSubItemError.set(1);
      assertThatThrownBy(() -> adapter.saveMessages(ws, batch))
              .isInstanceOf(ApiProblem.class)
              .extracting("status", "code")
              .containsExactly(503, "SERVICE_UNAVAILABLE");
      bulkSubItemError.set(0);

      failMgetStatus.set(500);
      assertThatThrownBy(() -> adapter.readAfterStrict(ws, conv, 0, 10))
              .isInstanceOf(ApiProblem.class)
              .extracting("status", "code")
              .containsExactly(503, "SERVICE_UNAVAILABLE");
    } finally {
      server.stop(0);
    }
  }

  private static void respond(com.sun.net.httpserver.HttpExchange exchange, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json");
    exchange.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = exchange.getResponseBody()) {
      out.write(bytes);
    }
  }
}
