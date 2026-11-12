package workbench.collaboration.infrastructure.contract;

import workbench.collaboration.interfaces.dto.DeviceDtos;
import workbench.collaboration.interfaces.dto.PlatformDtos;
import workbench.collaboration.interfaces.dto.ProjectDtos;
import workbench.collaboration.interfaces.dto.RepositoryDtos;

import com.networknt.schema.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * 模块：双端同源契约校验中心 (Contracts)
 *
 * <p>【功能定义】
 * 统一加载并编译打包在类路径下的平台标准 JSON Schema（platform/resources.json 清单定义）。
 * 提供对 HTTP 请求体、设备上传报文以及对外输出响应的强类型 Schema 校验与反序列化保护。
 *
 * <p>【安全与高可用不变量 (Why)】
 * - 离线沙箱闭环：严禁在校验过程中发起外部网络请求下载 $ref 引用，所有 $ref 只能落到本地打包的已知 Schema 清单中；
 * - 拒绝隐式静默丢弃：请求反序列化前必须完整通过 Schema 校验，未知字段或畸形类型直接阻断；
 * - 跨端一致性夹具自检：提供 smoke() 方法，运行与 Node.js 测试套件完全一致的 JSON 夹具，核对 Java Record 双端序列化形态。
 *
 * <p>【协作边界】
 * - 上游调用方：Application (contracts 模式)、BoundaryFilter、DeviceAppService 及后续协作应用服务。
 * - 下游依赖方：NetworkNT JSON Schema Validator、Jackson JsonMapper。
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
            if (id.isEmpty() || sources.put(id, content) != null) {
                throw new IllegalStateException("契约资源标识重复或缺失");
            }
        }

        // 先检查引用只落到已登记源，避免校验库在引用缺失时尝试请求外部 URL
        sources.forEach((id, content) -> checkReferences(mapper.readTree(content), URI.create(id), sources.keySet()));
        registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12, b -> b.schemas(sources));

        for (var entry : sources.entrySet()) {
            JsonNode node = mapper.readTree(entry.getValue());
            Schema meta = registry.getSchema(SchemaLocation.of("https://json-schema.org/draft/2020-12/schema"));
            if (!meta.validate(entry.getValue(), InputFormat.JSON).isEmpty()) {
                throw new IllegalStateException("契约 schema 不合法");
            }
            for (String name : node.path("$defs").propertyNames()) {
                if (types.put(name, registry.getSchema(SchemaLocation.of(entry.getKey() + "#/$defs/" + name))) != null) {
                    throw new IllegalStateException("契约类型重名");
                }
            }
        }

        // OpenAPI 不复制对象形状，逐一检查它所引用的本地定义是否确实已在本地 Schema 登记
        for (JsonNode file : catalog.get("openapi")) {
            checkOpenApi(mapper.readTree(resource("platform/openapi/" + safeName(file.asText()))));
        }
        for (JsonNode file : catalog.get("fixtures")) {
            mapper.readTree(resource("platform/fixtures/" + safeName(file.asText())));
        }
    }

    private void checkReferences(JsonNode value, URI base, Set<String> registered) {
        if (value.isObject()) {
            if (value.has("$ref")) {
                URI target = base.resolve(value.get("$ref").asText());
                String document = target.toString().split("#", 2)[0];
                if (!registered.contains(document)) {
                    throw new IllegalStateException("schema 引用未登记");
                }
            }
            value.properties().forEach(e -> checkReferences(e.getValue(), base, registered));
        } else if (value.isArray()) {
            value.forEach(v -> checkReferences(v, base, registered));
        }
    }

    private void checkOpenApi(JsonNode value) {
        if (value.isObject()) {
            if (value.has("$ref")) {
                String ref = value.get("$ref").asText();
                if (!ref.matches("\\.\\./schema/[a-zA-Z0-9_./-]+#/[$]defs/[a-zA-Z0-9_]+")) {
                    throw new IllegalStateException("OpenAPI 引用不是本地定义");
                }
                String[] parts = ref.substring("../schema/".length()).split("#/\\$defs/");
                boolean listed = false;
                for (JsonNode name : catalog.get("schemas")) {
                    if (name.asText().equals(parts[0])) {
                        listed = true;
                        break;
                    }
                }
                if (!listed || !types.containsKey(parts[1])) {
                    throw new IllegalStateException("OpenAPI 引用未登记");
                }
            }
            value.properties().forEach(e -> checkOpenApi(e.getValue()));
        } else if (value.isArray()) {
            value.forEach(this::checkOpenApi);
        }
    }

    private static String safeName(String name) {
        if (!name.matches("(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\\.json")) {
            throw new IllegalStateException("契约清单路径无效");
        }
        return name;
    }

    /**
     * 从类路径安全读取契约静态资源内容。
     */
    public String resource(String path) {
        try (InputStream stream = Contracts.class.getClassLoader().getResourceAsStream(path)) {
            if (stream == null) {
                throw new IllegalStateException("构建缺少登记资源: " + path);
            }
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new IllegalStateException("无法读取契约资源", e);
        }
    }

    /**
     * 根据契约名称校验 JSON 格式字符串是否符合定义规范。
     *
     * @param name Schema 定义类型名
     * @param json 待校验的 JSON 字符串
     * @return 校验通过返回 true，不符合返回 false
     */
    public boolean valid(String name, String json) {
        Schema schema = types.get(name);
        if (schema == null) {
            throw new IllegalArgumentException("未知契约类型: " + name);
        }
        return schema.validate(json, InputFormat.JSON, c -> c.executionConfig(e -> e.formatAssertionsEnabled(true))).isEmpty();
    }

    /**
     * 将对象序列化为 JSON 并强校验其是否满足指定的输出契约。
     */
    public String encode(String type, Object value) {
        String json = mapper.writeValueAsString(value);
        if (!valid(type, json)) {
            throw new IllegalStateException("输出不符合契约: " + type);
        }
        return json;
    }

    /**
     * 先校验 JSON 报文契约，再安全反序列化为目标 Java Record 实例。
     */
    public <T> T decode(String type, String json, Class<T> target) {
        if (!valid(type, json)) {
            throw new IllegalArgumentException("请求不符合契约: " + type);
        }
        return mapper.readValue(json, target);
    }

    /**
     * 执行平台与 Java 端跨语言夹具冒烟核验。
     */
    public void smoke() {
        List<Map<String, Object>> results = new ArrayList<>();
        Map<String, Class<?>> records = Map.ofEntries(
                Map.entry("CurrentUserResponse", PlatformDtos.CurrentUserResponse.class),
                Map.entry("DemoUsersResponse", PlatformDtos.DemoUsersResponse.class),
                Map.entry("WorkspaceListResponse", PlatformDtos.WorkspaceListResponse.class),
                Map.entry("MembersResponse", PlatformDtos.MembersResponse.class),
                Map.entry("DemoLoginRequest", PlatformDtos.DemoLoginRequest.class),
                Map.entry("CsrfResponse", PlatformDtos.CsrfResponse.class),
                Map.entry("MetaResponse", PlatformDtos.MetaResponse.class),
                Map.entry("HealthResponse", PlatformDtos.HealthResponse.class),
                Map.entry("ErrorResponse", PlatformDtos.ErrorResponse.class),
                Map.entry("PlatformMessageHeader", PlatformDtos.PlatformMessageHeader.class),
                Map.entry("DeviceSummary", DeviceDtos.DeviceSummary.class),
                Map.entry("DeviceRegistrationRequest", DeviceDtos.DeviceRegistrationRequest.class),
                Map.entry("DeviceRegistrationResponse", DeviceDtos.DeviceRegistrationResponse.class),
                Map.entry("DeviceListResponse", DeviceDtos.DeviceListResponse.class),
                Map.entry("DeviceRevokedResponse", DeviceDtos.DeviceRevokedResponse.class),
                Map.entry("ProjectCreateRequest", ProjectDtos.ProjectCreateRequest.class),
                Map.entry("ProjectPatchRequest", ProjectDtos.ProjectPatchRequest.class),
                Map.entry("ProjectMemberAddRequest", ProjectDtos.ProjectMemberAddRequest.class),
                Map.entry("RepositoryCreateRequest", RepositoryDtos.RepositoryCreateRequest.class),
                Map.entry("ProjectSummary", ProjectDtos.ProjectSummary.class),
                Map.entry("ProjectMemberListResponse", ProjectDtos.ProjectMemberListResponse.class),
                Map.entry("ProjectRepositoryListResponse", ProjectDtos.ProjectRepositoryListResponse.class)
        );

        for (JsonNode file : catalog.get("fixtures")) {
            for (JsonNode fixture : mapper.readTree(resource("platform/fixtures/" + safeName(file.asText())))) {
                String type = fixture.get("schema").asText();
                boolean valid = valid(type, fixture.get("data").toString());
                if (valid != fixture.get("valid").asBoolean()) {
                    throw new IllegalStateException("共同夹具失败: " + fixture.get("name").asText());
                }
                if (valid && records.containsKey(type)) {
                    Object record = mapper.treeToValue(fixture.get("data"), records.get(type));
                    encode(type, record);
                }
                results.add(Map.of("name", fixture.get("name").asText(), "valid", valid));
            }
        }
        System.out.println(mapper.writeValueAsString(Map.of("engine", "java", "results", results)));
    }
}
