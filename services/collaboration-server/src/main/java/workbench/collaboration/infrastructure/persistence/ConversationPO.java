package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：会话控制表持久化对象 (ConversationPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 核心小表 wb_conversation 的持久化实体（Persistent Object）。
 * 遵循“零分表精简状态”规范：仅持久化会话的控制状态、绑定的执行设备/项目、
 * 会话单调连续序号发生器（next_sequence）以及当前活跃执行标识。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationMapper、ConversationConverter、ConversationRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_conversation")
public class ConversationPO {

    /** 物理聚簇自增主键（BIGINT UNSIGNED），用于底层高效索引与物理存储 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 会话全局唯一业务标识 (UUID) */
    @TableField("id")
    private String id;

    /** 所属工作区标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 会话标题 */
    @TableField("title")
    private String title;

    /** 会话创建者用户标识 */
    @TableField("created_by_user_id")
    private String createdByUserId;

    /** 当前拥有该会话控制权的用户标识 */
    @TableField("current_user_id")
    private String currentUserId;

    /** 绑定的执行设备标识（Electron Daemon 所在设备） */
    @TableField("device_id")
    private String deviceId;

    /** 绑定的项目标识 */
    @TableField("project_id")
    private String projectId;

    /** 绑定的 Agent 运行配置标识 */
    @TableField("agent_config_id")
    private String agentConfigId;

    /** 下一个待分配的单调连续事件序号 */
    @TableField("next_sequence")
    private Long nextSequence;

    /** 绑定的 ACP 本地引擎会话标识 */
    @TableField("native_session_id")
    private String nativeSessionId;

    /** 当前运行中的执行标识（为空表示空闲） */
    @TableField("active_execution_id")
    private String activeExecutionId;

    /** 创建时间戳（毫秒） */
    @TableField("created_at_ms")
    private Long createdAtMs;

    /** 最近一次状态更新时间戳（毫秒） */
    @TableField("updated_at_ms")
    private Long updatedAtMs;

    public Long getPkId() {
        return pkId;
    }

    public void setPkId(Long pkId) {
        this.pkId = pkId;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public void setWorkspaceId(String workspaceId) {
        this.workspaceId = workspaceId;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getCreatedByUserId() {
        return createdByUserId;
    }

    public void setCreatedByUserId(String createdByUserId) {
        this.createdByUserId = createdByUserId;
    }

    public String getCurrentUserId() {
        return currentUserId;
    }

    public void setCurrentUserId(String currentUserId) {
        this.currentUserId = currentUserId;
    }

    public String getDeviceId() {
        return deviceId;
    }

    public void setDeviceId(String deviceId) {
        this.deviceId = deviceId;
    }

    public String getProjectId() {
        return projectId;
    }

    public void setProjectId(String projectId) {
        this.projectId = projectId;
    }

    public String getAgentConfigId() {
        return agentConfigId;
    }

    public void setAgentConfigId(String agentConfigId) {
        this.agentConfigId = agentConfigId;
    }

    public Long getNextSequence() {
        return nextSequence;
    }

    public void setNextSequence(Long nextSequence) {
        this.nextSequence = nextSequence;
    }

    public String getNativeSessionId() {
        return nativeSessionId;
    }

    public void setNativeSessionId(String nativeSessionId) {
        this.nativeSessionId = nativeSessionId;
    }

    public String getActiveExecutionId() {
        return activeExecutionId;
    }

    public void setActiveExecutionId(String activeExecutionId) {
        this.activeExecutionId = activeExecutionId;
    }

    public Long getCreatedAtMs() {
        return createdAtMs;
    }

    public void setCreatedAtMs(Long createdAtMs) {
        this.createdAtMs = createdAtMs;
    }

    public Long getUpdatedAtMs() {
        return updatedAtMs;
    }

    public void setUpdatedAtMs(Long updatedAtMs) {
        this.updatedAtMs = updatedAtMs;
    }
}
