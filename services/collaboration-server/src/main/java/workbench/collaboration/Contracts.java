package workbench.collaboration;

import com.networknt.schema.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 同源契约边界：清单 → 本地 schema/引用校验 → 编译 → wire 数据校验。
 * Maven 原字节打包 contracts 源；资源和引用不合法时阻止启动，不访问网络补齐。
 */
public final class Contracts {
  private final JsonMapper mapper = JsonMapper.builder().build();
  private final Map<String, Schema> types = new LinkedHashMap<>();
  private final JsonNode catalog;
  private final SchemaRegistry registry;

  public Contracts() {
    catalog = mapper.readTree(resource("platform/resources.json"));
    Map<String, String> sources = new LinkedHashMap<>();
    for (JsonNode name : catalog.get("schemas")) {
      String path = safeName(name.asText());
      String content = resource("platform/schema/" + path);
      JsonNode node = mapper.readTree(content);
      String id = node.path("$id").asText();
      if (id.isEmpty() || sources.put(id, content) != null) throw new IllegalStateException("契约资源标识重复或缺失");
    }
    // 先检查引用只落到已登记源，避免校验库在引用缺失时请求外部 URL。
    sources.forEach((id, content) -> checkReferences(mapper.readTree(content), URI.create(id), sources.keySet()));
    registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12, b -> b.schemas(sources));
    for (var entry : sources.entrySet()) {
      JsonNode node = mapper.readTree(entry.getValue());
      Schema meta = registry.getSchema(SchemaLocation.of("https://json-schema.org/draft/2020-12/schema"));
      if (!meta.validate(entry.getValue(), InputFormat.JSON).isEmpty()) throw new IllegalStateException("契约 schema 不合法");
      for (String name : node.path("$defs").propertyNames()) {
        if (types.put(name, registry.getSchema(SchemaLocation.of(entry.getKey() + "#/$defs/" + name))) != null) throw new IllegalStateException("契约类型重名");
      }
    }
    // OpenAPI 不复制对象形状，逐一检查它所引用的本地定义是否确实登记。
    for (JsonNode file : catalog.get("openapi")) checkOpenApi(mapper.readTree(resource("platform/openapi/" + safeName(file.asText()))));
    for (JsonNode file : catalog.get("fixtures")) mapper.readTree(resource("platform/fixtures/" + safeName(file.asText())));
  }

  private void checkReferences(JsonNode value, URI base, Set<String> registered) {
    if (value.isObject()) {
      if (value.has("$ref")) {
        URI target = base.resolve(value.get("$ref").asText());
        String document = target.toString().split("#", 2)[0];
        if (!registered.contains(document)) throw new IllegalStateException("schema 引用未登记");
      }
      value.properties().forEach(e -> checkReferences(e.getValue(), base, registered));
    } else if (value.isArray()) value.forEach(v -> checkReferences(v, base, registered));
  }
  private void checkOpenApi(JsonNode value) {
    if (value.isObject()) {
      if (value.has("$ref")) {
        String ref = value.get("$ref").asText();
        if (!ref.matches("\\.\\./schema/[a-zA-Z0-9_./-]+#/[$]defs/[a-zA-Z0-9_]+")) throw new IllegalStateException("OpenAPI 引用不是本地定义");
        String[] parts = ref.substring("../schema/".length()).split("#/\\$defs/");
        boolean listed = false;
        for (JsonNode name : catalog.get("schemas")) if (name.asText().equals(parts[0])) listed = true;
        if (!listed || !types.containsKey(parts[1])) throw new IllegalStateException("OpenAPI 引用未登记");
      }
      value.properties().forEach(e -> checkOpenApi(e.getValue()));
    } else if (value.isArray()) value.forEach(this::checkOpenApi);
  }
  private static String safeName(String name) {
    if (!name.matches("(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\\.json")) throw new IllegalStateException("契约清单路径无效");
    return name;
  }
  public String resource(String path) {
    try (InputStream stream = Contracts.class.getClassLoader().getResourceAsStream(path)) {
      if (stream == null) throw new IllegalStateException("构建缺少登记资源");
      return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
    } catch (java.io.IOException e) { throw new IllegalStateException("无法读取契约资源", e); }
  }
  /** 业务形状不符合时返回 false；配置/未知类型属于服务端错误，不静默放行。 */
  public boolean valid(String name, String json) {
    Schema schema = types.get(name);
    if (schema == null) throw new IllegalArgumentException("未知契约类型");
    return schema.validate(json, InputFormat.JSON, c -> c.executionConfig(e -> e.formatAssertionsEnabled(true))).isEmpty();
  }
  public String encode(String type, Object value) {
    String json = mapper.writeValueAsString(value);
    if (!valid(type, json)) throw new IllegalStateException("输出不符合契约");
    return json;
  }
  /** 请求只在 schema 校验后转换为 record，未知字段和类型不允许隐式丢弃。 */
  public <T> T decode(String type, String json, Class<T> target) {
    if (!valid(type, json)) throw new IllegalArgumentException("请求不符合契约");
    return mapper.readValue(json, target);
  }
  /** Node/Java 使用完全相同的夹具，并额外核对 Java record 实际序列化形状。 */
  public void smoke() {
    List<Map<String, Object>> results = new ArrayList<>();
    Map<String, Class<?>> records = Map.ofEntries(
      Map.entry("CurrentUserResponse", PlatformDtos.CurrentUserResponse.class), Map.entry("DemoUsersResponse", PlatformDtos.DemoUsersResponse.class),
      Map.entry("WorkspaceListResponse", PlatformDtos.WorkspaceListResponse.class), Map.entry("MembersResponse", PlatformDtos.MembersResponse.class),
      Map.entry("DemoLoginRequest", PlatformDtos.DemoLoginRequest.class), Map.entry("CsrfResponse", PlatformDtos.CsrfResponse.class),
      Map.entry("MetaResponse", PlatformDtos.MetaResponse.class), Map.entry("HealthResponse", PlatformDtos.HealthResponse.class),
      Map.entry("ErrorResponse", PlatformDtos.ErrorResponse.class), Map.entry("PlatformMessageHeader", PlatformDtos.PlatformMessageHeader.class),
      Map.entry("ConversationSummary", workbench.collaboration.conversation.ConversationDtos.ConversationSummary.class),
      Map.entry("Message", workbench.collaboration.conversation.ConversationDtos.Message.class),
      Map.entry("ExecutionView", workbench.collaboration.conversation.ConversationDtos.ExecutionView.class),
      Map.entry("CreateConversationRequest", workbench.collaboration.conversation.ConversationDtos.CreateConversationRequest.class),
      Map.entry("CreateConversationResponse", workbench.collaboration.conversation.ConversationDtos.CreateConversationResponse.class),
      Map.entry("SendInputRequest", workbench.collaboration.conversation.ConversationDtos.SendInputRequest.class),
      Map.entry("InputSavedResponse", workbench.collaboration.conversation.ConversationDtos.InputSavedResponse.class),
      Map.entry("CancelExecutionRequest", workbench.collaboration.conversation.ConversationDtos.CancelExecutionRequest.class),
      Map.entry("CancelExecutionResponse", workbench.collaboration.conversation.ConversationDtos.CancelExecutionResponse.class),
      Map.entry("HistoryResponse", workbench.collaboration.conversation.ConversationDtos.HistoryResponse.class),
      Map.entry("DeviceSummary", workbench.collaboration.device.DeviceDtos.DeviceSummary.class),
      Map.entry("ProjectSummary", workbench.collaboration.device.DeviceDtos.ProjectSummary.class),
      Map.entry("DeviceRegistrationRequest", workbench.collaboration.device.DeviceDtos.DeviceRegistrationRequest.class),
      Map.entry("DeviceRegistrationResponse", workbench.collaboration.device.DeviceDtos.DeviceRegistrationResponse.class),
      Map.entry("DeviceListResponse", workbench.collaboration.device.DeviceDtos.DeviceListResponse.class),
      Map.entry("DeviceRevokedResponse", workbench.collaboration.device.DeviceDtos.DeviceRevokedResponse.class),
      Map.entry("ProjectListResponse", workbench.collaboration.device.DeviceDtos.ProjectListResponse.class),
      Map.entry("ProjectSavedResponse", workbench.collaboration.device.DeviceDtos.ProjectSavedResponse.class),
      Map.entry("ExecutionStartMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionStartMessage.class),
      Map.entry("ExecutionCancelMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionCancelMessage.class),
      Map.entry("ExecutionStartDecisionMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionStartDecisionMessage.class),
      Map.entry("ExecutionAcceptedMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionAcceptedMessage.class),
      Map.entry("ExecutionNativeBoundMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionNativeBoundMessage.class),
      Map.entry("ExecutionRunningMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionRunningMessage.class),
      Map.entry("ExecutionOutputMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionOutputMessage.class),
      Map.entry("ExecutionTerminalMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionTerminalMessage.class),
      Map.entry("ExecutionCancelReceivedMessage", workbench.collaboration.execution.ExecutionDtos.ExecutionCancelReceivedMessage.class),
      Map.entry("RecordBatchResult", workbench.collaboration.execution.ExecutionDtos.RecordBatchResult.class),
      Map.entry("ReconcileResult", workbench.collaboration.execution.ExecutionDtos.ReconcileResult.class),
      Map.entry("DeviceWelcomeMessage", workbench.collaboration.device.DeviceDtos.DeviceWelcomeMessage.class),
      Map.entry("DeviceReadyMessage", workbench.collaboration.device.DeviceDtos.DeviceReadyMessage.class),
      Map.entry("DeviceProblemMessage", workbench.collaboration.device.DeviceDtos.DeviceProblemMessage.class),
      Map.entry("DeviceProjectChangedMessage", workbench.collaboration.device.DeviceDtos.DeviceProjectChangedMessage.class));
    workbench.collaboration.execution.ExecutionCodec codec = new workbench.collaboration.execution.ExecutionCodec();
    for (JsonNode file : catalog.get("fixtures")) for (JsonNode fixture : mapper.readTree(resource("platform/fixtures/" + safeName(file.asText())))) {
      String type = fixture.get("schema").asText();
      boolean valid = valid(type, fixture.get("data").toString());
      if (valid != fixture.get("valid").asBoolean()) throw new IllegalStateException("共同夹具失败: " + fixture.get("name").asText());
      if (valid && records.containsKey(type)) {
        Object record = mapper.treeToValue(fixture.get("data"), records.get(type));
        encode(type, record);
        // 同一份夹具的确定性正文/指纹必须两端一致；Java 不另存预期值。
        if (fixture.has("canonical")) {
          if (!codec.body(record).equals(fixture.get("canonical").asText())) throw new IllegalStateException("确定性正文不一致: " + fixture.get("name").asText());
          if (!codec.sha256(record).equals(fixture.get("bodySha256").asText())) throw new IllegalStateException("确定性指纹不一致: " + fixture.get("name").asText());
        }
      }
      results.add(Map.of("name", fixture.get("name").asText(), "valid", valid));
    }
    System.out.println(mapper.writeValueAsString(Map.of("engine", "java", "results", results)));
  }
}
