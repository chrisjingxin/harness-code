package workbench.collaboration.infrastructure.messaging;

import org.junit.jupiter.api.Test;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.stream.DaemonWebSocketHandler;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/** 三个主题按会话、设备和空间分开。没有本机连接时，Daemon 命令直接丢掉。 */
class EventRoutingTest {
  @Test
  void topicsUseTheSpecifiedPartitionKeys() {
    assertThat(Topics.CONVERSATION).isEqualTo("wb.conversation.events");
    assertThat(Topics.DAEMON).isEqualTo("wb.daemon.commands");
    assertThat(Topics.SEARCH).isEqualTo("wb.search.index");
    assertThat(Topics.conversationKey("conv")).isEqualTo("conv");
    assertThat(Topics.daemonKey("dev")).isEqualTo("dev");
    assertThat(Topics.searchKey("ws")).isEqualTo("ws");
  }

  @Test
  void localBusDeliversEachPublishToItsOwnListener() {
    LocalEventBus bus = new LocalEventBus();
    List<String> seen = new ArrayList<>();
    bus.onConversation((key, json) -> seen.add("conversation:" + key));
    bus.onDaemon((key, json) -> seen.add("daemon:" + key));
    bus.onSearch((key, json) -> seen.add("search:" + key));
    bus.publishConversationEvent("conv", "{}");
    bus.publishDaemonCommand("dev", "{}");
    bus.publishSearchIndex("ws", "{}");
    assertThat(seen).containsExactly("conversation:conv", "daemon:dev", "search:ws");
  }

  @Test
  void daemonCommandWithoutALocalSocketIsDropped() {
    WorkbenchProperties properties = new WorkbenchProperties();
    properties.setOrigin("http://127.0.0.1:18084");
    var handler = new DaemonWebSocketHandler(mock(workbench.collaboration.application.service.DeviceAppService.class),
      new workbench.collaboration.infrastructure.cache.MemoryPresence(), new Contracts(), properties);
    handler.dispatch("33333333-3333-4333-8333-333333333333", "{\"type\":\"execution.start\"}");
  }
}
