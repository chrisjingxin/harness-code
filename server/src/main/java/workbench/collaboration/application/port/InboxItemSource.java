package workbench.collaboration.application.port;

import workbench.collaboration.interfaces.dto.InboxDtos.InboxItem;

import java.util.List;

/**
 * 模块：全局待办收件箱数据源扩展接口 (InboxItemSource)
 *
 * <p>【功能定义】
 * 服务端可插拔待办来源 SPI。每类需要真人异步拍板的业务（如 Task、后续知识审核/系统地图审核/
 * 团队技能审核/会话批注）各自实现一个 Spring Bean，由 InboxAppService 自动聚合并以业务现态投影为唯一真相。
 *
 * <p>【协作边界】
 * - 上游调用方：InboxAppService。
 * - 下游实现方：TaskInboxSource 等各业务域数据源实现。
 */
public interface InboxItemSource {

    /**
     * 收件箱查询条件上下文。
     *
     * @param bucket            查询桶：action_required / sent / resolved
     * @param workspaceIdFilter 可选团队过滤（为 null 时聚合全部已加入团队）
     * @param nowMs             当前时刻毫秒时间戳（用于统一计算 30 天已处理时间窗口）
     */
    record InboxSourceQuery(String bucket, String workspaceIdFilter, long nowMs) {}

    /** 来源类型标识，例如 "task"（后续可扩展 "knowledge_proposal"、"skill_proposal" 等）。 */
    String sourceType();

    /**
     * 返回当前用户有权限查看且符合查询桶条件的待办或追踪投影条目。
     * 实现方必须在线校验用户的团队成员、项目成员与在职状态。
     */
    List<InboxItem> listForUser(String userId, InboxSourceQuery query);
}
