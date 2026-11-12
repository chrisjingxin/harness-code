package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

/**
 * 模块：会话控制表持久化对象 (ConversationPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 核心小表 wb_conversation 的持久化实体（Persistent Object）。
 * HC-211 新形态：仅持久化项目归属、主人设备、运行状态简报与已同步序号水位；
 * 不再保留成员轮换、活跃执行与服务端序号发生器旧列。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationMapper、ConversationConverter、ConversationRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_conversation")
public class ConversationPO {

    /** 物理主键（BIGINT UNSIGNED AUTO_INCREMENT） */
    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    /** 会话全局唯一业务标识 (UUID) */
    @TableField("conversation_id")
    private String conversationId;

    /** 所属工作区标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 所属业务项目标识 */
    @TableField("project_id")
    private String projectId;

    /** 会话主人（创建者）用户标识，固定不变 */
    @TableField("owner_user_id")
    private String ownerUserId;

    /** 主人执行设备标识 */
    @TableField("device_id")
    private String deviceId;

    /** 绑定的 Agent 运行配置标识（允许为空） */
    @TableField("agent_config_id")
    private String agentConfigId;

    /** 关联的任务卡片标识（允许为空） */
    @TableField("task_id")
    private String taskId;

    /** 会话运行状态：idle/running/waiting_approval/error */
    @TableField("status")
    private Integer status;

    /** 会话标题 */
    @TableField("title")
    private String title;

    /** 最近简报正文（允许为空） */
    @TableField("brief_text")
    private String briefText;

    /** 简报来源：rule/agent */
    @TableField("brief_source")
    private Integer briefSource;

    /** 简报最近更新时间戳（毫秒，允许为空） */
    @TableField("brief_updated_at")
    private LocalDateTime briefUpdatedAt;

    /** 已确认的最大已上传消息序号 */
    @TableField("synced_sequence")
    private Long syncedSequence;

    /** 绑定的底层 Agent 本地会话标识（允许为空） */
    @TableField("native_session_id")
    private String nativeSessionId;

    /** 创建时间戳（毫秒） */
    @TableField("created_at")
    private LocalDateTime createdAt;

    /** 最近一次状态更新时间戳（毫秒） */
    @TableField("updated_at")
    private LocalDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getConversationId() {
        return conversationId;
    }

    public void setConversationId(String conversationId) {
        this.conversationId = conversationId;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public void setWorkspaceId(String workspaceId) {
        this.workspaceId = workspaceId;
    }

    public String getProjectId() {
        return projectId;
    }

    public void setProjectId(String projectId) {
        this.projectId = projectId;
    }

    public String getOwnerUserId() {
        return ownerUserId;
    }

    public void setOwnerUserId(String ownerUserId) {
        this.ownerUserId = ownerUserId;
    }

    public String getDeviceId() {
        return deviceId;
    }

    public void setDeviceId(String deviceId) {
        this.deviceId = deviceId;
    }

    public String getAgentConfigId() {
        return agentConfigId;
    }

    public void setAgentConfigId(String agentConfigId) {
        this.agentConfigId = agentConfigId;
    }

    public String getTaskId() {
        return taskId;
    }

    public void setTaskId(String taskId) {
        this.taskId = taskId;
    }

    public Integer getStatus() {
        return status;
    }

    public void setStatus(Integer status) {
        this.status = status;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getBriefText() {
        return briefText;
    }

    public void setBriefText(String briefText) {
        this.briefText = briefText;
    }

    public Integer getBriefSource() {
        return briefSource;
    }

    public void setBriefSource(Integer briefSource) {
        this.briefSource = briefSource;
    }

    public LocalDateTime getBriefUpdatedAt() {
        return briefUpdatedAt;
    }

    public void setBriefUpdatedAt(LocalDateTime briefUpdatedAt) {
        this.briefUpdatedAt = briefUpdatedAt;
    }

    public Long getSyncedSequence() {
        return syncedSequence;
    }

    public void setSyncedSequence(Long syncedSequence) {
        this.syncedSequence = syncedSequence;
    }

    public String getNativeSessionId() {
        return nativeSessionId;
    }

    public void setNativeSessionId(String nativeSessionId) {
        this.nativeSessionId = nativeSessionId;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public LocalDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(LocalDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
}
