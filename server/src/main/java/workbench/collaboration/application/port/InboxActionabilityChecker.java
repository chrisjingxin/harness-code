package workbench.collaboration.application.port;

/**
 * 模块：外部通知发送前现态复核扩展接口 (InboxActionabilityChecker)
 *
 * <p>【功能定义】
 * 供外部 IM 出站调度引擎在合批等待或失败退避后、真正发往外部通道前再次核对业务现态。
 * 若待办已在等待窗口内被处理、取消或接收人失去资格，返回 false 以便引擎自动取消推送，实现免打扰消噪。
 *
 * <p>【协作边界】
 * - 上游调用方：停点 2 外部通知出站调度引擎。
 * - 下游实现方：TaskInboxSource 及后续各业务域来源。
 */
public interface InboxActionabilityChecker {

    /** 是否支持复核指定的外部通知事件类型。 */
    boolean supports(String eventType);

    /**
     * 复核当前时刻该对象对指定接收人是否仍需动作或提醒。
     * 实现方必须在线校验接收人的在职、团队及项目成员资格与对象当前状态。
     */
    boolean isStillActionable(String userId, String workspaceId, String projectId, String eventType, String objectId);
}
