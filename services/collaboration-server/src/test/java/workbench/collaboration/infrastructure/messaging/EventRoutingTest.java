package workbench.collaboration.infrastructure.messaging;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** 检索索引主题以 workspaceId 作分区键；本地总线只分发检索文档。 */
class EventRoutingTest {
  @Test
  void topicsUseTheSpecifiedPartitionKey() {
    assertThat(Topics.SEARCH).isEqualTo("wb.search.index");
    assertThat(Topics.searchKey("ws")).isEqualTo("ws");
  }

  @Test
  void localBusDeliversSearchDocumentsToItsListener() {
    LocalEventBus bus = new LocalEventBus();
    List<String> seen = new ArrayList<>();
    bus.onSearch((key, json) -> seen.add("search:" + key + ":" + json));
    bus.publishSearchIndex("ws", "{}");
    assertThat(seen).containsExactly("search:ws:{}");
  }
}
