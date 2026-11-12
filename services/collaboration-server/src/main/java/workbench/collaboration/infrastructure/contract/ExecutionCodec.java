package workbench.collaboration.infrastructure.contract;

import tools.jackson.databind.JsonNode;
import workbench.collaboration.interfaces.dto.ExecutionDtos;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 模块：执行指令确定性序列化与哈希编解码器 (ExecutionCodec)
 *
 * <p>【功能定义】
 * 提供对向端侧下发的指令报文（如 ExecutionStartMessage）进行确定性规范化编码、SHA-256 指纹提取与防篡改签名封包。
 *
 * <p>【确定性编码规范 (Why)】
 * - 字段顺序严格由 Java Record 字段声明顺序锁定；
 * - 签名计算时先移除 payload.bodySha256，采用紧凑 JSON 编码（UTF-8 字符集、无 BOM 头、无多余空白）；
 * - 任何后续反序列化再序列化，必须产出完全一致的十六进制摘要，确保指令指纹在跨网络节点间绝不漂移。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService、DeviceAppService、Contracts。
 * - 下游依赖方：Jackson JsonMapper、MessageDigest。
 */
public final class ExecutionCodec {

    private final JsonMapper mapper = JsonMapper.builder().build();

    /**
     * 获取移除了 bodySha256 签名字段后的规范化 JSON 报文字符串。
     *
     * @param message 待处理的指令消息对象
     * @return 规范化紧凑 JSON 报文
     */
    public String body(Object message) {
        JsonNode root = mapper.readTree(mapper.writeValueAsString(message));
        JsonNode payload = root.get("payload");
        if (payload instanceof ObjectNode object) {
            object.remove("bodySha256");
        }
        return mapper.writeValueAsString(root);
    }

    /**
     * 计算规范化报文的 SHA-256 十六进制摘要。
     *
     * @param message 消息对象
     * @return 64 位十六进制 SHA-256 字符串
     */
    public String sha256(Object message) {
        return hex(body(message));
    }

    /**
     * 计算任意字符串基于 UTF-8 编码的 SHA-256 十六进制哈希。
     *
     * @param value 输入字符串
     * @return 64 位小写十六进制字符串
     */
    public static String hex(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    /**
     * 对消息进行签名封包（Seal）：计算消息正文哈希并回填至 payload.bodySha256 字段。
     *
     * @param message 原始待签名消息对象
     * @param type 目标强类型 Class
     * @return 回填了签名摘要后的全新强类型实例
     */
    public <T> T seal(Object message, Class<T> type) {
        JsonNode root = mapper.readTree(mapper.writeValueAsString(message));
        ObjectNode payload = (ObjectNode) root.get("payload");
        payload.remove("bodySha256");
        String hash = hex(mapper.writeValueAsString(root));
        payload.put("bodySha256", hash);
        return mapper.treeToValue(root, type);
    }

    /**
     * 校验传入消息自带的签名哈希是否与按规则重新计算出的摘要完全一致。
     *
     * @param message 待核验消息对象
     * @return 签名有效且匹配返回 true，缺失签名或篡改返回 false
     */
    public boolean verify(Object message) {
        JsonNode root = mapper.readTree(mapper.writeValueAsString(message));
        JsonNode payload = root.get("payload");
        if (!(payload instanceof ObjectNode object) || !object.has("bodySha256")) {
            return false;
        }
        String stored = object.get("bodySha256").asText();
        object.remove("bodySha256");
        return stored.equals(hex(mapper.writeValueAsString(root)));
    }

    /**
     * 将对象格式化为 JSON 字符串。
     *
     * @param value 任意对象
     * @return JSON 字符串
     */
    public String json(Object value) {
        return mapper.writeValueAsString(value);
    }

    /**
     * 根据执行消息类型解析对应的契约 Schema 定义名。
     *
     * @param message 执行消息对象
     * @return Schema 契约类型名称
     */
    public String schemaName(Object message) {
        return switch (message) {
            case ExecutionDtos.ExecutionStartMessage ignored -> "ExecutionStartMessage";
            case ExecutionDtos.ExecutionCancelMessage ignored -> "ExecutionCancelMessage";
            case ExecutionDtos.ExecutionStartDecisionMessage ignored -> "ExecutionStartDecisionMessage";
            case ExecutionDtos.ExecutionAcceptedMessage ignored -> "ExecutionAcceptedMessage";
            case ExecutionDtos.ExecutionNativeBoundMessage ignored -> "ExecutionNativeBoundMessage";
            case ExecutionDtos.ExecutionRunningMessage ignored -> "ExecutionRunningMessage";
            case ExecutionDtos.ExecutionOutputMessage ignored -> "ExecutionOutputMessage";
            case ExecutionDtos.ExecutionTerminalMessage ignored -> "ExecutionTerminalMessage";
            case ExecutionDtos.ExecutionCancelReceivedMessage ignored -> "ExecutionCancelReceivedMessage";
            case ExecutionDtos.ExecutionEventsAckMessage ignored -> "ExecutionEventsAckMessage";
            default -> throw new IllegalArgumentException("未知执行消息");
        };
    }

    /**
     * 提取消息中的全局消息标识 messageId。
     */
    public String messageId(Object message) {
        return switch (message) {
            case ExecutionDtos.ExecutionStartMessage m -> m.messageId();
            case ExecutionDtos.ExecutionCancelMessage m -> m.messageId();
            case ExecutionDtos.ExecutionStartDecisionMessage m -> m.messageId();
            case ExecutionDtos.ExecutionAcceptedMessage m -> m.messageId();
            case ExecutionDtos.ExecutionNativeBoundMessage m -> m.messageId();
            case ExecutionDtos.ExecutionRunningMessage m -> m.messageId();
            case ExecutionDtos.ExecutionOutputMessage m -> m.messageId();
            case ExecutionDtos.ExecutionTerminalMessage m -> m.messageId();
            case ExecutionDtos.ExecutionCancelReceivedMessage m -> m.messageId();
            case ExecutionDtos.ExecutionEventsAckMessage m -> m.messageId();
            default -> throw new IllegalArgumentException("未知执行消息");
        };
    }

    /**
     * 提取消息负载中的本地 Runner 序号 runnerSequence（若存在）。
     */
    public String runnerSequence(Object message) {
        return switch (message) {
            case ExecutionDtos.ExecutionAcceptedMessage m -> m.payload().runnerSequence();
            case ExecutionDtos.ExecutionNativeBoundMessage m -> m.payload().runnerSequence();
            case ExecutionDtos.ExecutionRunningMessage m -> m.payload().runnerSequence();
            case ExecutionDtos.ExecutionOutputMessage m -> m.payload().runnerSequence();
            case ExecutionDtos.ExecutionTerminalMessage m -> m.payload().runnerSequence();
            case ExecutionDtos.ExecutionCancelReceivedMessage m -> m.payload().runnerSequence();
            default -> null;
        };
    }
}
