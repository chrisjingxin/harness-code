package workbench.collaboration.execution;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 确定性字节与摘要：字段顺序由 record 声明保证；去掉 payload.bodySha256 后紧凑编码，
 * UTF-8 无 BOM、无额外空白。任何 re-serialize 都不能改变首次命令的指纹。
 */
public final class ExecutionCodec {
  private final JsonMapper mapper = JsonMapper.builder().build();

  public String body(Object message) {
    JsonNode root = mapper.readTree(mapper.writeValueAsString(message));
    JsonNode payload = root.get("payload");
    if (payload instanceof ObjectNode object) object.remove("bodySha256");
    return mapper.writeValueAsString(root);
  }

  public String sha256(Object message) { return hex(body(message)); }

  public static String hex(String value) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException e) { throw new IllegalStateException("SHA-256 不可用", e); }
  }

  /** 计算并写回 payload 最后一位；返回同一记录的新实例。 */
  public <T> T seal(Object message, Class<T> type) {
    JsonNode root = mapper.readTree(mapper.writeValueAsString(message));
    ObjectNode payload = (ObjectNode) root.get("payload");
    payload.remove("bodySha256");
    String hash = hex(mapper.writeValueAsString(root));
    payload.put("bodySha256", hash);
    return mapper.treeToValue(root, type);
  }

  /** 已带指纹的消息必须与重新计算的摘要一致；不一致按冲突失败，不静默改写。 */
  public boolean verify(Object message) {
    JsonNode root = mapper.readTree(mapper.writeValueAsString(message));
    JsonNode payload = root.get("payload");
    if (!(payload instanceof ObjectNode object) || !object.has("bodySha256")) return false;
    String stored = object.get("bodySha256").asText();
    object.remove("bodySha256");
    return stored.equals(hex(mapper.writeValueAsString(root)));
  }

  public String json(Object value) { return mapper.writeValueAsString(value); }

  /** 每种内层只对应一个登记类型；未知形状不允许进入业务。 */
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

  public String executionId(Object message) {
    return switch (message) {
      case ExecutionDtos.ExecutionStartMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionCancelMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionStartDecisionMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionAcceptedMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionNativeBoundMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionRunningMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionOutputMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionTerminalMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionCancelReceivedMessage m -> m.payload().executionId();
      case ExecutionDtos.ExecutionEventsAckMessage m -> m.payload().executionId();
      default -> throw new IllegalArgumentException("未知执行消息");
    };
  }
}
