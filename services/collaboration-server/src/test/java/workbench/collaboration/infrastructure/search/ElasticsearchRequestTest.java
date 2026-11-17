package workbench.collaboration.infrastructure.search;

import okhttp3.OkHttpClient;
import okio.Buffer;
import org.junit.jupiter.api.Test;

import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

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
    assertThat(encoded).contains("\"lt\":99").contains("conv\\\"quote").contains("key\\\"word").contains("\"size\":25");
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
}
