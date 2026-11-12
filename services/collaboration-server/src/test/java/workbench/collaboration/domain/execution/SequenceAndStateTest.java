package workbench.collaboration.domain.execution;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 序号只在会话头上连续占用。状态只能沿已知边走，终态不能再派发。 */
class SequenceAndStateTest {
  @Test
  void advanceConsumesAContiguousSpan() {
    assertThat(SequenceNumbers.advance(2, 2)).isEqualTo(4);
    assertThat(SequenceNumbers.advance(1, 1)).isEqualTo(2);
    assertThatThrownBy(() -> SequenceNumbers.advance(0, 1)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> SequenceNumbers.advance(1, 0)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void queuedMayCancelButCannotSkipToSucceeded() {
    assertThat(ExecutionStateMachine.legal("queued", "cancelled")).isTrue();
    assertThat(ExecutionStateMachine.legal("queued", "dispatching")).isTrue();
    assertThat(ExecutionStateMachine.legal("queued", "succeeded")).isFalse();
    assertThat(ExecutionStateMachine.legal("queued", "queued")).isFalse();
    assertThat(ExecutionStateMachine.legal("cancelled", "running")).isFalse();
    assertThat(ExecutionStateMachine.terminal("cancelled")).isTrue();
    assertThat(ExecutionStateMachine.terminal("queued")).isFalse();
  }
}
