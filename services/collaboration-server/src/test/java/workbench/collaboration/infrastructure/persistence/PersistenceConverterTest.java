package workbench.collaboration.infrastructure.persistence;

import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.LocalRepoBinding;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.contract.Digests;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
  void conversationKeepsEmptyBriefTaskAndSession() {
    // 全列 NOT NULL：未绑定/无简报统一 '' 空串哨兵，进出领域不丢
    Conversation conversation = new Conversation(
      "c1", "w1", "p1", "u1", "d1", "", "", "idle", "标题", "", "rule", 1L, 0L, "", 1L, 2L);
    ConversationPO po = ConversationConverter.toPo(conversation);
    assertThat(po.getNativeSessionId()).isEmpty();
    assertThat(po.getTaskId()).isEmpty();
    assertThat(po.getBriefText()).isEmpty();
    assertThat(po.getStatus()).isEqualTo(1);
    assertThat(po.getBriefSource()).isEqualTo(1);
    assertThat(po.getPkId()).isNull();
    assertThat(ConversationConverter.toConversation(po)).isEqualTo(conversation);
  }

  @Test
  void projectStatusAndVersionRoundTrips() {
    Project project = new Project("p1", "w1", "账单", "desc", "u1", ProjectStatus.ARCHIVED, 7L, 1L, 2L);
    ProjectPO po = ProjectConverter.toPo(project);
    assertThat(po.getStatus()).isEqualTo(2);
    assertThat(po.getVersion()).isEqualTo(7L);
    assertThat(po.getPkId()).isNull();
    assertThat(ProjectConverter.toProject(po)).isEqualTo(project);
  }

  @Test
  void projectMemberRemovedStatusRoundTrips() {
    ProjectMember member = new ProjectMember("p1", "u1", MemberStatus.REMOVED, 1L, 2L);
    ProjectMemberPO po = ProjectConverter.toPo(member);
    assertThat(po.getStatus()).isEqualTo(2);
    assertThat(ProjectConverter.toMember(po)).isEqualTo(member);
  }

  @Test
  void projectRepositoryRefRoundTrips() {
    ProjectRepositoryRef ref = new ProjectRepositoryRef("p1", "r1", 9L);
    ProjectRepositoryRefPO po = ProjectConverter.toPo(ref);
    assertThat(po.getPkId()).isNull();
    assertThat(ProjectConverter.toReference(po)).isEqualTo(ref);
  }

  @Test
  void repositoryAndBindingRoundTrips() {
    Repository repository = new Repository("r1", "w1", "中台", "git@x:y.git", "main", RepositoryStatus.ACTIVE, "u1", 1L, 2L);
    RepositoryPO po = RepositoryConverter.toPo(repository);
    assertThat(po.getStatus()).isEqualTo(1);
    // remote_url 唯一约束落摘要列：写入侧必须算好 SHA-256
    assertThat(po.getRemoteUrlSha256()).isEqualTo(Digests.sha256Hex("git@x:y.git"));
    assertThat(RepositoryConverter.toRepository(po)).isEqualTo(repository);

    LocalRepoBinding binding = new LocalRepoBinding("d1", "r1", 5L);
    LocalRepoBindingPO bindingPo = RepositoryConverter.toPo(binding);
    assertThat(bindingPo.getPkId()).isNull();
    assertThat(RepositoryConverter.toBinding(bindingPo)).isEqualTo(binding);
  }

  @Test
  void unknownStatusCodesFailFast() {
    ProjectPO projectPo = new ProjectPO();
    projectPo.setStatus(9);
    assertThatThrownBy(() -> ProjectConverter.toProject(projectPo)).isInstanceOf(IllegalArgumentException.class);

    RepositoryPO repositoryPo = new RepositoryPO();
    repositoryPo.setStatus(9);
    assertThatThrownBy(() -> RepositoryConverter.toRepository(repositoryPo)).isInstanceOf(IllegalArgumentException.class);
  }
}
