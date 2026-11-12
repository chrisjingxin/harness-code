package workbench.collaboration.infrastructure.persistence;

import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.SharedProject;
import workbench.collaboration.domain.identity.User;

import static org.assertj.core.api.Assertions.assertThat;

/** 0/1 和空会话指针进出领域对象时不能丢。 */
class PersistenceConverterTest {
  @Test
  void userEnabledFlagRoundTrips() {
    User disabled = new User("u1", "user01", "用户 01", false, 10L);
    UserPO po = IdentityConverter.toPo(disabled);
    assertThat(po.getEnabled()).isZero();
    assertThat(po.getPkId()).isNull();
    assertThat(IdentityConverter.toUser(po)).isEqualTo(disabled);

    po.setEnabled(null);
    assertThat(IdentityConverter.toUser(po).enabled()).isFalse();
  }

  @Test
  void deviceRevokedAndProjectShareRoundTrip() {
    Device device = new Device("d1", "w1", "u1", "inst", "ledger", "本机", "aa", "reg", "body", true, 1L, 2L);
    assertThat(DeviceConverter.toDevice(DeviceConverter.toPo(device))).isEqualTo(device);

    SharedProject project = new SharedProject("w1", "d1", "p1", "仓库", false, 3L, "[]", 4L);
    DeviceProjectPO row = DeviceConverter.toPo(project);
    assertThat(row.getShareEnabled()).isZero();
    assertThat(DeviceConverter.toProject(row)).isEqualTo(project);
  }

  @Test
  void conversationKeepsNullSessionAndExecution() {
    Conversation conversation = new Conversation("c1", "w1", "标题", "u1", "u1", "d1", "p1", "cfg", 7L, null, null, 1L, 2L);
    ConversationPO po = ConversationConverter.toPo(conversation);
    assertThat(po.getNativeSessionId()).isNull();
    assertThat(po.getActiveExecutionId()).isNull();
    assertThat(po.getPkId()).isNull();
    assertThat(ConversationConverter.toConversation(po)).isEqualTo(conversation);
  }
}
