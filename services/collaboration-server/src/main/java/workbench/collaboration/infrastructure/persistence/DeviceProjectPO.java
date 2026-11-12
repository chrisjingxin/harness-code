package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：设备共享项目持久化对象 (DeviceProjectPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_device_project 的持久化实体。
 * 同一工作区内 project_id 业务唯一。保存共享开关、乐观锁版本号以及可用的 Agent 配置 JSON。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceProjectMapper、DeviceConverter、DeviceRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_device_project")
public class DeviceProjectPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 所属工作区标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 持有该项目的设备标识 */
    @TableField("device_id")
    private String deviceId;

    /** 项目业务唯一标识 */
    @TableField("project_id")
    private String projectId;

    /** 项目展示名称 */
    @TableField("name")
    private String name;

    /** 是否开启共享（1: 开启, 0: 关闭） */
    @TableField("share_enabled")
    private Integer shareEnabled;

    /** 乐观锁版本号（每次更新版本单调递增，用于 CAS 并发控制） */
    @TableField("share_version")
    private Long shareVersion;

    /** 项目支持的 Agent 运行配置 JSON 字符串 */
    @TableField("agent_configs_json")
    private String agentConfigsJson;

    /** 最近一次更新时间戳（毫秒） */
    @TableField("updated_at_ms")
    private Long updatedAtMs;

    public Long getPkId() {
        return pkId;
    }

    public void setPkId(Long pkId) {
        this.pkId = pkId;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public void setWorkspaceId(String workspaceId) {
        this.workspaceId = workspaceId;
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

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Integer getShareEnabled() {
        return shareEnabled;
    }

    public void setShareEnabled(Integer shareEnabled) {
        this.shareEnabled = shareEnabled;
    }

    public Long getShareVersion() {
        return shareVersion;
    }

    public void setShareVersion(Long shareVersion) {
        this.shareVersion = shareVersion;
    }

    public String getAgentConfigsJson() {
        return agentConfigsJson;
    }

    public void setAgentConfigsJson(String agentConfigsJson) {
        this.agentConfigsJson = agentConfigsJson;
    }

    public Long getUpdatedAtMs() {
        return updatedAtMs;
    }

    public void setUpdatedAtMs(Long updatedAtMs) {
        this.updatedAtMs = updatedAtMs;
    }
}
