package workbench.collaboration.infrastructure.persistence;

import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.identity.User;

import static org.assertj.core.api.Assertions.assertThat;

/** 0/1 标记与可空字段进出领域对象时不能丢。 */
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
  void deviceRevokedFlagRoundTrips() {
    Device device = new Device("d1", "u1", "inst", "ledger", "本机", "aa", "reg", "body", true, 1L, 2L);
    DevicePO po = DeviceConverter.toPo(device);
    assertThat(po.getRevoked()).isEqualTo(1);
    assertThat(DeviceConverter.toDevice(po)).isEqualTo(device);
  }

  @Test
  void conversationKeepsNullBriefTaskAndSession() {
    Conversation conversation = new Conversation(
      "c1", "w1", "p1", "u1", "d1", null, null, "idle", "标题", null, "rule", null, 0L, null, 1L, 2L);
    ConversationPO po = ConversationConverter.toPo(conversation);
    assertThat(po.getNativeSessionId()).isNull();
    assertThat(po.getTaskId()).isNull();
    assertThat(po.getBriefText()).isNull();
    assertThat(po.getPkId()).isNull();
    assertThat(ConversationConverter.toConversation(po)).isEqualTo(conversation);
  }
}
