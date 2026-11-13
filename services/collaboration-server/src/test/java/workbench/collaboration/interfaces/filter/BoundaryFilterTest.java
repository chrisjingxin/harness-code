package workbench.collaboration.interfaces.filter;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.http.ApiResponses;
import workbench.collaboration.interfaces.http.RouteCatalog;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 边界在认证之前拒绝坏来源、重复查询和超限正文。错误体只有约定字段。 */
class BoundaryFilterTest {
  private static final String ORIGIN = "http://127.0.0.1:18084";
  private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
  private MockMvc mvc;

  @BeforeEach
  void setUp() {
    mvc = MockMvcBuilders.standaloneSetup(new Probe())
      .addFilters(new BoundaryFilter(new Contracts(), new RouteCatalog(), ORIGIN, "127.0.0.1:18084"))
      .build();
  }

  @Test
  void duplicateQueryUnknownRouteAndWrongMethodAreRejected() throws Exception {
    mvc.perform(get("/api/v1/workspaces/" + WORKSPACE + "/devices?limit=1&limit=1").headers(ok()))
      .andExpect(status().isBadRequest()).andExpect(jsonPath("$.body.code").value("INVALID_REQUEST"));
    mvc.perform(get("/api/v1/missing").headers(ok()))
      .andExpect(status().isNotFound()).andExpect(jsonPath("$.body.code").value("RESOURCE_NOT_FOUND"));
    mvc.perform(post("/api/v1/meta").headers(ok()))
      .andExpect(status().isMethodNotAllowed()).andExpect(jsonPath("$.body.code").value("METHOD_NOT_ALLOWED"));
  }

  @Test
  void originProtocolAndPayloadAreRejectedBeforeTheController() throws Exception {
    mvc.perform(get("/api/v1/meta").header("Host", "127.0.0.1:18084").header("Origin", "https://rejected.invalid").header("X-Workbench-Protocol-Version", "1"))
      .andExpect(status().isForbidden()).andExpect(jsonPath("$.body.code").value("REQUEST_SOURCE_REJECTED"));
    mvc.perform(get("/api/v1/meta").header("Host", "127.0.0.1:18084").header("Origin", ORIGIN))
      .andExpect(status().is(426)).andExpect(jsonPath("$.body.code").value("PROTOCOL_VERSION_UNSUPPORTED"));
    mvc.perform(post("/api/v1/workspaces/" + WORKSPACE + "/devices").headers(ok()).contentType("application/json").content("x".repeat(17000)))
      .andExpect(status().is(413)).andExpect(jsonPath("$.body.code").value("PAYLOAD_TOO_LARGE"))
      .andExpect(jsonPath("$.returnCode").value("CLB0003"))
      .andExpect(jsonPath("$.body.retryable").value(false))
      .andExpect(jsonPath("$.body.requestId").exists())
      .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("stack"))));
  }

  @Test
  void acceptedReadReturnsJson() throws Exception {
    mvc.perform(get("/api/v1/meta").headers(ok()))
      .andExpect(status().isOk())
      .andExpect(header().string("Content-Type", org.hamcrest.Matchers.containsString("application/json")))
      .andExpect(jsonPath("$.returnCode").value("SUC0000"))
      .andExpect(jsonPath("$.body.loginMode").value("demo"));
  }

  private static org.springframework.http.HttpHeaders ok() {
    org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
    headers.set("Host", "127.0.0.1:18084");
    headers.set("Origin", ORIGIN);
    headers.set("X-Workbench-Protocol-Version", "1");
    return headers;
  }

  @Test
  void userIdPathAndOwnerIdQueryRequire32HexCharsWithoutHyphens() throws Exception {
    String projectId = "55555555-5555-4555-8555-555555555555";
    String validUserId = "11111111111141118111111111111111";
    String hyphenatedUserId = "11111111-1111-4111-8111-111111111111";
    mvc.perform(delete("/api/v1/workspaces/" + WORKSPACE + "/projects/" + projectId + "/members/" + validUserId).headers(ok()))
      .andExpect(status().isOk());
    mvc.perform(delete("/api/v1/workspaces/" + WORKSPACE + "/projects/" + projectId + "/members/" + hyphenatedUserId).headers(ok()))
      .andExpect(status().isBadRequest()).andExpect(jsonPath("$.body.code").value("INVALID_REQUEST"));
    mvc.perform(get("/api/v1/workspaces/" + WORKSPACE + "/projects/" + projectId + "/conversations?ownerId=" + validUserId).headers(ok()))
      .andExpect(status().isOk());
    mvc.perform(get("/api/v1/workspaces/" + WORKSPACE + "/projects/" + projectId + "/conversations?ownerId=" + hyphenatedUserId).headers(ok()))
      .andExpect(status().isBadRequest()).andExpect(jsonPath("$.body.code").value("INVALID_REQUEST"));
  }

  @RestController
  static class Probe {
    @GetMapping("/api/v1/meta")
    ResponseEntity<String> meta() { return ApiResponses.json(200, "{\"productVersion\":\"0.2.0\",\"protocolVersion\":1,\"loginMode\":\"demo\"}"); }

    @PostMapping("/api/v1/workspaces/{workspaceId}/devices")
    ResponseEntity<String> create() { return ApiResponses.json(201, "{}"); }

    @DeleteMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/members/{userId}")
    ResponseEntity<String> removeMember() { return ApiResponses.json(200, "{}"); }

    @GetMapping("/api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations")
    ResponseEntity<String> listConversations() { return ApiResponses.json(200, "{}"); }
  }
}
