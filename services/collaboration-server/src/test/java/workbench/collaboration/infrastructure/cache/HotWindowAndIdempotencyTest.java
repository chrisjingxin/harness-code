package workbench.collaboration.infrastructure.cache;

import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.execution.ExecutionState;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 单机内存和 Redis 使用同一套键、条数和冲突语义。这里不连接 Redis。 */
class HotWindowAndIdempotencyTest {
  @Test
  void keysMatchTheRedisContract() {
    assertThat(CacheKeys.idempotency("ws", "actor", "input.send", "req")).isEqualTo("wb:idemp:ws:actor:input.send:req");
    assertThat(CacheKeys.presence("dev")).isEqualTo("wb:daemon:presence:dev");
    assertThat(CacheKeys.execution("exec")).isEqualTo("wb:exec:state:exec");
    assertThat(CacheKeys.source("exec", 3)).isEqualTo("wb:exec:source:exec:3");
    assertThat(CacheKeys.messages("conv")).isEqualTo("wb:conv:msgs:conv");
    assertThat(CacheKeys.events("conv")).isEqualTo("wb:conv:events:conv");
    assertThat(CacheKeys.IDEMPOTENCY_TTL_SECONDS).isEqualTo(3600);
    assertThat(CacheKeys.PRESENCE_TTL_SECONDS).isEqualTo(45);
    assertThat(CacheKeys.EXECUTION_TTL_SECONDS).isEqualTo(24 * 3600);
    assertThat(CacheKeys.MESSAGE_TTL_SECONDS).isEqualTo(7 * 24 * 3600);
    assertThat(CacheKeys.EVENT_TTL_SECONDS).isEqualTo(24 * 3600);
    assertThat(CacheKeys.MESSAGE_LIMIT).isEqualTo(100);
    assertThat(CacheKeys.EVENT_LIMIT).isEqualTo(200);
    assertThat(CacheKeys.trimUntilRank(100)).isEqualTo(-101);
  }

  @Test
  void sameBodyReplaysAndDifferentBodyConflicts() throws Exception {
    MemoryIdempotency port = new MemoryIdempotency();
    CountDownLatch inside = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      Future<String> first = pool.submit(() -> {
        var existing = port.begin("ws", "actor", "input.send", "req", "body");
        assertThat(existing).isEmpty();
        inside.countDown();
        release.await();
        port.remember("ws", "actor", "input.send", "req", "body", "{\"ok\":true}");
        return "{\"ok\":true}";
      });
      Future<String> second = pool.submit(() -> {
        inside.await();
        return port.begin("ws", "actor", "input.send", "req", "body").orElseThrow();
      });
      release.countDown();
      assertThat(first.get()).isEqualTo(second.get());
      assertThat(port.find("ws", "actor", "input.send", "req")).contains("{\"ok\":true}");
      assertThatThrownBy(() -> port.begin("ws", "actor", "input.send", "req", "other"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("REQUEST_ID_CONFLICT");
    } finally {
      release.countDown();
      pool.shutdownNow();
    }
  }

  @Test
  void windowsKeepTheNewestHundredMessagesAndTwoHundredEvents() {
    MemoryHotWindow window = new MemoryHotWindow();
    for (int sequence = 1; sequence <= 101; sequence++) window.save(message(sequence));
    assertThat(window.messageCount("conv")).isEqualTo(100);
    assertThat(window.oldestMessageSequence("conv")).contains(2L);
    assertThat(window.recent("conv", 1).getFirst().sequence()).isEqualTo(101);

    for (int sequence = 1; sequence <= 201; sequence++) window.append("conv", sequence, "{\"sequence\":\"" + sequence + "\"}");
    assertThat(window.eventCount("conv")).isEqualTo(200);
    var range = window.range("conv", 0, 201, 200);
    assertThat(range).hasSize(200);
    assertThat(range.getFirst().sequence()).isEqualTo(2);
    assertThat(range.getLast().sequence()).isEqualTo(201);
  }

  @Test
  void sourceFingerprintSkipsTheSameAndRejectsADifferentOne() {
    MemoryExecutionState states = new MemoryExecutionState();
    assertThat(states.rememberSource("exec", 1, "fp")).isTrue();
    assertThat(states.rememberSource("exec", 1, "fp")).isFalse();
    assertThatThrownBy(() -> states.rememberSource("exec", 1, "other")).isInstanceOf(IllegalStateException.class);
    ExecutionState state = new ExecutionState("exec", "conv", "input", 1, "user", "queued", "queued", "none", null, 1, 1, "");
    states.save(state);
    assertThat(states.find("exec")).contains(state);
  }

  private static Message message(long sequence) {
    return new Message("m" + sequence, "ws", "conv", "exec", "user", "user", "user01", "用户 01", null, sequence, "text", "completed", sequence);
  }
}
