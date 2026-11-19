package workbench.collaboration.domain.conversation;

/**
 * 模块：会话简报值对象 (Brief)
 *
 * <p>【功能定义】
 * 项目成员无需拉取全文即可了解"这台会话在做什么"的摘要：
 * 运行状态、最近一段简报正文与其来源。
 * 简报随同步批次由主人 Runner 上送，Java 只做透传存储，从不代为生成（briefSource=agent 预留）。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService、ConversationDtos。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * @param status 会话运行状态（idle/running/waiting_approval/error）
 * @param briefText 简报正文（可为 null 表示本批次不带简报）
 * @param briefSource 简报来源：rule（规则生成）/agent（预留）
 */
public record Brief(String status, String briefText, String briefSource) {}
