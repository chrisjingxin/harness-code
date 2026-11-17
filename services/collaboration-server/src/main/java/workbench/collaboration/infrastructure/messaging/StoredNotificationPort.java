package workbench.collaboration.infrastructure.messaging;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.infrastructure.persistence.NotificationStore;

import java.util.Map;
import java.util.UUID;

/**
 * 业务提交时持久化用户通知。提交以后唤醒本机流并发出集群信号；
 * 信号重复或丢失不会改写发件箱。HTTP 读取事实始终来自发件箱。
 */
@Component
public class StoredNotificationPort implements NotificationPort {
    private static final Logger LOGGER = LoggerFactory.getLogger(StoredNotificationPort.class);
    private final NotificationStore store;
    private final NotificationSignal signal;
    private final ObjectProvider<KafkaEventBus> kafka;

    public StoredNotificationPort(NotificationStore store, NotificationSignal signal,
                                  ObjectProvider<KafkaEventBus> kafka) {
        this.store = store;
        this.signal = signal;
        this.kafka = kafka;
    }

    @Override
    public void publish(String eventType, String subjectId, Map<String, Object> payload) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("业务通知必须在写事务中保存");
        }
        String workspace = (String) payload.get("workspaceId");
        String actor = (String) payload.get("actorId");
        String project = (String) payload.getOrDefault("projectId", "");
        String creator = (String) payload.getOrDefault("creatorId", "");
        String assignee = (String) payload.getOrDefault("assigneeId", "");
        var recipients = store.recipients(workspace, project, actor, creator, assignee);
        if (recipients.isEmpty()) return;
        String eventId = UUID.randomUUID().toString();
        store.append(workspace, project, eventId, eventType, subjectId, System.currentTimeMillis(), recipients);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                signal.wake();
                try {
                    var bus = kafka.getIfAvailable();
                    if (bus != null) bus.publishNotification(workspace, eventId);
                } catch (RuntimeException unavailable) {
                    LOGGER.warn("通知 Kafka 唤醒信号暂不可用，事件 {} 仍可从数据库补读", eventId);
                }
            }
        });
    }
}
