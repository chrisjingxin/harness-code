package workbench.collaboration.infrastructure.messaging;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.NotificationPort;

import java.util.Map;

/**
 * 模块：本地日志通知实现 (LoggingNotificationPort)
 *
 * <p>【功能定义】
 * NotificationPort 的本任务默认实现：把领域事件以结构化 JSON 落日志。
 * HC-212 接入 wb.collab.notifications 主题前，让事件载荷形状先在代码与日志中可观测，
 * 不产生任何跨进程副作用。
 *
 * <p>【协作边界】
 * - 上游调用方：ServerConfiguration 装配。
 * - 下游依赖方：SLF4J。
 */
public final class LoggingNotificationPort implements NotificationPort {

    private static final Logger LOGGER = LoggerFactory.getLogger(LoggingNotificationPort.class);
    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Override
    public void publish(String eventType, String subjectId, Map<String, Object> payload) {
        LOGGER.info("notification {} subject={} payload={}", eventType, subjectId, JSON.writeValueAsString(payload));
    }
}
