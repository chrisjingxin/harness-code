package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：团队仓库目录表持久化对象 (RepositoryPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_repository 的持久化实体。
 * 团队级仓库目录：(workspace_id, remote_url) 唯一，
 * 归档条目保留行只读，仅翻转 status。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryMapper、RepositoryConverter、RepositoryCatalogImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_repository")
public class RepositoryPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 仓库全局唯一业务标识 (UUID) */
    @TableField("id")
    private String id;

    /** 所属团队标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 目录显示名 */
    @TableField("name")
    private String name;

    /** 远端仓库地址（团队内唯一键） */
    @TableField("remote_url")
    private String remoteUrl;

    /** 默认分支名 */
    @TableField("default_branch")
    private String defaultBranch;

    /** 目录状态：active/archived */
    @TableField("status")
    private String status;

    /** 登记者用户标识 */
    @TableField("created_by_user_id")
    private String createdByUserId;

    /** 登记时间戳（毫秒） */
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

    public String getRemoteUrl() {
        return remoteUrl;
    }

    public void setRemoteUrl(String remoteUrl) {
        this.remoteUrl = remoteUrl;
    }

    public String getDefaultBranch() {
        return defaultBranch;
    }

    public void setDefaultBranch(String defaultBranch) {
        this.defaultBranch = defaultBranch;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getCreatedByUserId() {
        return createdByUserId;
    }

    public void setCreatedByUserId(String createdByUserId) {
        this.createdByUserId = createdByUserId;
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
