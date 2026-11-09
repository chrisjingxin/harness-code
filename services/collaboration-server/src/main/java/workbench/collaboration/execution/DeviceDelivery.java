package workbench.collaboration.execution;

import workbench.collaboration.conversation.ConversationDtos.ExecutionRow;

/**
 * 设备交付端口：只负责把已提交的 start/cancel 放到真实 socket。
 * 实现不得写会话/执行表，也不得在数据库事务内调用。
 */
public interface DeviceDelivery {
  /** 返回 false 表示当前连接不可用；已写入的 dispatching 事实保留，等待核对/重发。 */
  boolean deliverStart(ExecutionRow execution, ExecutionDtos.ExecutionStartMessage start);
  boolean deliverCancel(ExecutionRow execution, ExecutionDtos.ExecutionCancelMessage cancel);
  boolean isReady(String deviceId);
}
