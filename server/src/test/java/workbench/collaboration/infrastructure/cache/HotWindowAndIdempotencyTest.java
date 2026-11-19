package workbench.collaboration.infrastructure.cache;

import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.conversation.Message;

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
    assertThat(CacheKeys.idempotency("ws", "actor", "project.create", "req")).isEqualTo("wb:idemp:ws:actor:project.create:req");
    assertThat(CacheKeys.messages("conv")).isEqualTo("wb:conv:msgs:conv");
    assertThat(CacheKeys.IDEMPOTENCY_TTL_SECONDS).isEqualTo(3600);
    assertThat(CacheKeys.MESSAGE_TTL_SECONDS).isEqualTo(7 * 24 * 3600);
    assertThat(CacheKeys.MESSAGE_LIMIT).isEqualTo(100);
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
        var existing = port.begin("ws", "actor", "project.create", "req", "body");
        assertThat(existing).isEmpty();
        inside.countDown();
        release.await();
        port.remember("ws", "actor", "project.create", "req", "body", "{\"ok\":true}");
        return "{\"ok\":true}";
      });
      Future<String> second = pool.submit(() -> {
        inside.await();
        return port.begin("ws", "actor", "project.create", "req", "body").orElseThrow();
      });
      release.countDown();
      assertThat(first.get()).isEqualTo(second.get());
      assertThat(port.find("ws", "actor", "project.create", "req")).contains("{\"ok\":true}");
      assertThatThrownBy(() -> port.begin("ws", "actor", "project.create", "req", "other"))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage("REQUEST_ID_CONFLICT");
    } finally {
      release.countDown();
      pool.shutdownNow();
    }
  }

  @Test
  void windowKeepsTheNewestHundredMessages() {
    MemoryHotWindow window = new MemoryHotWindow();
    for (int sequence = 1; sequence <= 101; sequence++) {
      window.save(message(sequence));
    }
    assertThat(window.messageCount("conv")).isEqualTo(100);
    assertThat(window.oldestMessageSequence("conv")).contains(2L);
    assertThat(window.recent("conv", 1).getFirst().sequence()).isEqualTo(101);
    assertThat(window.find("ws", "m101")).isPresent();
  }

  private static Message message(long sequence) {
    return new Message("m" + sequence, "ws", "conv", "assistant", sequence, "{\"text\":\"hello\"}", sequence);
  }
}
