package workbench.collaboration.application.port;

/**
 * 模块：外部通知安全跳转链接构造接口 (DeepLinkBuilder)
 *
 * <p>【功能定义】
 * 为外部 IM 轻卡片生成定位工作台具体资源的安全跳转链接（默认生成 {@code workbench://open/...}）。
 * 若企业内部 IM 客户端禁止直接跳转自定义协议而要求先走内网 HTTPS 网关中转，
 * 企业侧只需替换此 Bean 即可，无需修改调度引擎或业务代码。
 *
 * <p>【安全约束】
 * 必须仅使用经过白名单校验的业务标识，严禁将外部不可信文本拼接进链接参数。
 */
public interface DeepLinkBuilder {

    /** 构造直达指定项目任务详情的只读跳转链接。 */
    String buildTaskLink(String workspaceId, String projectId, String taskId);

    /** 构造直达桌面全局收件箱的跳转链接（用于多条合批汇总卡片或团队级提醒）。 */
    String buildInboxLink();
}
