package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：业务项目表持久化对象 (ProjectPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_project 的持久化实体。
 * version 列为乐观并发版本：写路径经 CAS（version = expectedVersion）推进。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectMapper、ProjectConverter、ProjectRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_project")
public class ProjectPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 项目全局唯一业务标识 (UUID) */
    @TableField("id")
    private String id;

    /** 所属团队标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 项目显示名 */
    @TableField("name")
    private String name;

    /** 项目说明 */
    @TableField("description")
    private String description;

    /** 项目负责人用户标识 */
    @TableField("owner_user_id")
    private String ownerUserId;

    /** 项目状态：active/archived */
    @TableField("status")
    private String status;

    /** 乐观并发版本号，创建为 1，每次 CAS 写入 +1 */
    @TableField("version")
    private Long version;

    /** 创建时间戳（毫秒） */
    @TableField("created_at_ms")
    private Long createdAtMs;

    /** 最近修改时间戳（毫秒） */
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

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public String getOwnerUserId() {
        return ownerUserId;
    }

    public void setOwnerUserId(String ownerUserId) {
        this.ownerUserId = ownerUserId;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Long getVersion() {
        return version;
    }

    public void setVersion(Long version) {
        this.version = version;
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
