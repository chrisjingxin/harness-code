package workbench.collaboration.domain.execution;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 派发资格只看共享开关和执行配置，不碰数据库。 */
class ExecutionAuthDomainServiceTest {
  @Test
  void startsOnlyWhenShareAndConfigAreBothOn() {
    assertThat(ExecutionAuthDomainService.canStart(true, true)).isTrue();
    assertThat(ExecutionAuthDomainService.canStart(true, false)).isFalse();
    assertThat(ExecutionAuthDomainService.canStart(false, true)).isFalse();
    assertThat(ExecutionAuthDomainService.canStart(false, false)).isFalse();
  }
}
