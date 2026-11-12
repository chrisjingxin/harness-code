package workbench.collaboration.domain.conversation;

/**
 * 模块：会话聚合根模型 (Conversation)
 *
 * <p>【功能定义】
 * 表示协作工作台中归属于某个业务项目的共享会话头（Control Header）。
 * 遵循"控制面与数据面存算分离"原则：本模型仅持久化会话归属、主人设备、
 * 运行状态简报与已同步序号水位；消息正文由 Redis 热滑窗与 ES 承接。
 * HC-211 起会话为单写者模型：owner 固定为创建者，消息序号由主人 Runner 单调分配，
 * 服务端只校验连续与幂等（synced_sequence 水位），绝不代分配或远程驱动执行。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService、ConversationRepository、ConversationConverter。
 * - 下游依赖方：无外部框架依赖（纯领域层 Record）。
 *
 * <p>【字段语义契约】
 * @param id 会话全局唯一业务标识 (UUID)
 * @param workspaceId 所属工作区标识
 * @param projectId 所属业务项目标识（wb_project.id）
 * @param ownerUserId 会话主人用户标识（创建者，固定不变）
 * @param deviceId 主人执行设备标识
 * @param agentConfigId 会话绑定的智能体配置标识（空串表示未绑定）
 * @param taskId 关联的任务卡片标识（空串表示无，由 HC-212 任务域写入）
 * @param status 会话运行状态：idle/running/waiting_approval/error
 * @param title 会话标题
 * @param briefText 最近简报正文（由主人 Runner 随同步批次上送，空串表示无简报）
 * @param briefSource 简报来源：rule（规则生成）/agent（预留）
 * @param briefUpdatedAtMs 简报最近更新时间戳（毫秒，登记时取创建时间作基线）
 * @param syncedSequence 已确认的最大已上传消息序号（单调水位线）
 * @param nativeSessionId 绑定的底层 Agent 本地会话标识（空串表示未绑定）
 * @param createdAtMs 创建时间戳（毫秒）
 * @param updatedAtMs 最近一次更新时间戳（毫秒）
 */
public record Conversation(
        String id,
        String workspaceId,
        String projectId,
        String ownerUserId,
        String deviceId,
        String agentConfigId,
        String taskId,
        String status,
        String title,
        String briefText,
        String briefSource,
        long briefUpdatedAtMs,
        long syncedSequence,
        String nativeSessionId,
        long createdAtMs,
        long updatedAtMs
) {}
