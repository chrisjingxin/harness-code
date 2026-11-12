package workbench.collaboration.interfaces.stream;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.SubProtocolCapable;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.service.ConversationAppService;
import workbench.collaboration.application.service.DeviceAppService;
import workbench.collaboration.domain.device.DaemonCommandPort;
import workbench.collaboration.domain.device.DaemonPresence;
import workbench.collaboration.domain.device.DaemonPresencePort;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.DeviceDtos;
import workbench.collaboration.interfaces.dto.ExecutionDtos;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 模块：设备专属 WebSocket 长连接处理器 (DaemonWebSocketHandler)
 *
 * <p>【功能定义】
 * 管理服务端与物理 Electron Daemon 设备之间的双向全双工 WebSocket 长连接通道。
 * 同时实现 DaemonCommandPort（指令下发端口）与 SubProtocolCapable（子协议握手声明）：
 * 1. 入网问候（afterConnectionEstablished）：通道建立后立即登记 Redis 在线路由表，
 *    并向端侧连续推送 DeviceWelcomeMessage（告知心跳超时）与 DeviceReadyMessage；
 * 2. 接收端侧定稿推送（handleTextMessage）：接收端侧模型输出定稿或状态变更，
 *    通过 ConversationAppService.recordDaemonPush 进行指纹验重与会话全局推进，并回传 ExecutionEventsAckMessage；
 * 3. 路由指令下发（dispatch）：将启动/取消指令打包为规范 Envelope 封包下发给对应设备的物理连接。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring WebSocket 管道、ExecutionAppService。
 * - 下游依赖方：DeviceAppService、ConversationAppService、DaemonPresencePort、Contracts。
 */
@Component
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class DaemonWebSocketHandler extends TextWebSocketHandler implements DaemonCommandPort, SubProtocolCapable {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final DeviceAppService devices;
    private final ConversationAppService conversations;
    private final DaemonPresencePort presence;
    private final Contracts contracts;
    private final String nodeId;
    private final ConcurrentHashMap<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public DaemonWebSocketHandler(
            DeviceAppService devices,
            DaemonPresencePort presence,
            Contracts contracts,
            WorkbenchProperties properties
    ) {
        this(devices, null, presence, contracts, properties);
    }

    @Autowired
    public DaemonWebSocketHandler(
            DeviceAppService devices,
            @org.springframework.context.annotation.Lazy ConversationAppService conversations,
            DaemonPresencePort presence,
            Contracts contracts,
            WorkbenchProperties properties
    ) {
        this.devices = devices;
        this.conversations = conversations;
        this.presence = presence;
        this.contracts = contracts;
        this.nodeId = properties.getMiddleware().getNodeId();
    }

    @Override
    public List<String> getSubProtocols() {
        return List.of("workbench.device.v1");
    }

    public Device authenticate(String header) {
        return devices.authenticate(header);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws IOException {
        String deviceId = (String) session.getAttributes().get("deviceId");
        String connectionId = UUID.randomUUID().toString();
        session.getAttributes().put("connectionId", connectionId);
        sessions.put(deviceId, session);

        long now = System.currentTimeMillis();
        // 登记当前长连接所在的 Java 节点标识与连接标识
        presence.save(new DaemonPresence(deviceId, nodeId, connectionId, "ready", now));
        Device device = devices.authenticate("Bearer " + session.getAttributes().get("bearer"));

        String resumeId = UUID.randomUUID().toString();
        session.getAttributes().put("resumeId", resumeId);

        // 下发设备欢迎问候与就绪信令
        var welcome = new DeviceDtos.DeviceWelcomeMessage(
                1,
                UUID.randomUUID().toString(),
                "device.welcome",
                TimeCodec.utc(now),
                new DeviceDtos.DeviceWelcomePayload(device.id(), device.workspaceId(), device.ownerUserId(), device.ledgerId(), resumeId, 15000, 45000)
        );
        sendEnvelope(session, connectionId, JSON.readTree(contracts.encode("DeviceWelcomeMessage", welcome)));

        var ready = new DeviceDtos.DeviceReadyMessage(
                1,
                UUID.randomUUID().toString(),
                "device.ready",
                TimeCodec.utc(now),
                new DeviceDtos.DeviceReadyPayload(resumeId, device.ledgerId())
        );
        sendEnvelope(session, connectionId, JSON.readTree(contracts.encode("DeviceReadyMessage", ready)));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String deviceId = (String) session.getAttributes().get("deviceId");
        String connectionId = (String) session.getAttributes().getOrDefault("connectionId", session.getId());
        // 收到客户端任意报文即刷新其在 Redis 中的在线心跳
        presence.save(new DaemonPresence(deviceId, nodeId, connectionId, "ready", System.currentTimeMillis()));

        JsonNode root;
        try {
            root = JSON.readTree(message.getPayload());
        } catch (RuntimeException e) {
            return;
        }

        if (root.has("messages") && root.path("messages").isArray()) {
            for (JsonNode item : root.path("messages")) {
                handleSingleMessage(session, deviceId, connectionId, item);
            }
        } else if (root.has("message") && root.path("message").isObject()) {
            handleSingleMessage(session, deviceId, connectionId, root.path("message"));
        } else {
            handleSingleMessage(session, deviceId, connectionId, root);
        }
    }

    private void handleSingleMessage(WebSocketSession session, String deviceId, String connectionId, JsonNode body) {
        JsonNode payload = body.path("payload");
        String executionId = firstNonEmpty(text(body, "executionId"), text(payload, "executionId"));
        if (executionId.isEmpty()) {
            return;
        }
        String conversationId = firstNonEmpty(text(body, "conversationId"), text(payload, "conversationId"));
        long sequence = body.path("runnerSequence").asLong(payload.path("runnerSequence").asLong(0));
        String fingerprint = firstNonEmpty(text(body, "bodySha256"), text(payload, "bodySha256"), body.toString());
        String type = text(body, "type");
        String state = firstNonEmpty(
                text(body, "state"),
                text(payload, "state"),
                "execution.accepted".equals(type) ? "accepted" : "execution.running".equals(type) ? "running" : ""
        );
        String nativeSessionId = firstNonEmpty(text(body, "nativeSessionId"), text(payload, "nativeSessionId"));
        String reasonCode = firstNonEmpty(text(body, "reasonCode"), text(payload, "reasonCode"));
        String messageId = firstNonEmpty(text(body, "agentMessageId"), text(payload, "messageId"), text(payload.path("change"), "messageId"));
        String text = firstNonEmpty(text(body, "text"), text(payload, "text"), text(payload.path("change"), "text"));

        try {
            if (conversations != null && !conversationId.isEmpty()) {
                conversations.recordDaemonPush(
                        devices,
                        deviceId,
                        connectionId,
                        conversationId,
                        executionId,
                        sequence,
                        fingerprint,
                        messageId,
                        text.isEmpty() ? null : text,
                        state.isEmpty() ? null : state,
                        reasonCode.isEmpty() ? null : reasonCode,
                        nativeSessionId.isEmpty() ? null : nativeSessionId
                );
            } else {
                devices.recordBatch(deviceId, connectionId, executionId, sequence, fingerprint);
            }

            // 处理成功且存在有效来源序号时，向客户端回传 ACK 消息
            if (sequence > 0) {
                var ack = new ExecutionDtos.ExecutionEventsAckMessage(
                        1,
                        UUID.randomUUID().toString(),
                        "execution.events.ack",
                        TimeCodec.utc(System.currentTimeMillis()),
                        new ExecutionDtos.ExecutionEventsAckPayload(executionId, Long.toString(sequence))
                );
                sendEnvelope(session, connectionId, JSON.valueToTree(ack));
            }
        } catch (ApiProblem | IOException ignored) {
            // 容错设计 (Why)：业务冲突或校验失败只丢弃当前帧，绝不随意拆除物理连接
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String deviceId = (String) session.getAttributes().get("deviceId");
        if (deviceId != null && sessions.remove(deviceId, session)) {
            presence.remove(deviceId);
        }
    }

    @Override
    public void dispatch(String deviceId, String commandJson) {
        WebSocketSession session = sessions.get(deviceId);
        if (session == null || !session.isOpen()) {
            return;
        }
        String connectionId = (String) session.getAttributes().getOrDefault("connectionId", session.getId());
        try {
            JsonNode node = JSON.readTree(commandJson);
            if (node.has("connectionId") && node.has("message")) {
                session.sendMessage(new TextMessage(commandJson));
            } else {
                sendEnvelope(session, connectionId, node);
            }
        } catch (IOException | RuntimeException e) {
            if (sessions.remove(deviceId, session)) {
                presence.remove(deviceId);
            }
        }
    }

    private static void sendEnvelope(WebSocketSession session, String connectionId, JsonNode message) throws IOException {
        String json = JSON.writeValueAsString(Map.of("connectionId", connectionId, "message", message));
        session.sendMessage(new TextMessage(json));
    }

    private static String text(JsonNode node, String field) {
        return node == null ? "" : node.path(field).asString("");
    }

    private static String firstNonEmpty(String... candidates) {
        for (String c : candidates) {
            if (c != null && !c.isEmpty()) {
                return c;
            }
        }
        return "";
    }
}
