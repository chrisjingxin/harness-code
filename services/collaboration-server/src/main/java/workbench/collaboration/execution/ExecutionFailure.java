package workbench.collaboration.execution;

/** 执行事务边界错误；由设备通道映射为闭合 problem，不把堆栈或 SQL 发给 Runner。 */
public final class ExecutionFailure extends RuntimeException {
  public final String kind;
  public final String executionId;
  public final Long expectedRunnerSequence;
  public final Long lastCommittedRunnerSequence;

  public ExecutionFailure(String kind, String executionId) { this(kind, executionId, null, null); }

  public ExecutionFailure(String kind, String executionId, Long expected, Long committed) {
    super(kind);
    this.kind = kind; this.executionId = executionId;
    this.expectedRunnerSequence = expected; this.lastCommittedRunnerSequence = committed;
  }
}
