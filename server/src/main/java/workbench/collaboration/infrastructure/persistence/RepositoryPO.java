package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

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

    /** 物理主键（BIGINT UNSIGNED AUTO_INCREMENT） */
    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    /** 仓库全局唯一业务标识 (UUID) */
    @TableField("repository_id")
    private String repositoryId;

    /** 所属团队标识 */
    @TableField("workspace_id")
    private String workspaceId;

    /** 目录显示名 */
    @TableField("name")
    private String name;

    /** 远端仓库地址 */
    @TableField("remote_url")
    private String remoteUrl;
    /** remote_url 的 SHA-256 摘要（团队内唯一键，替代前缀索引防误冲突） */
    @TableField("remote_url_sha256")
    private String remoteUrlSha256;

    /** 默认分支名 */
    @TableField("default_branch")
    private String defaultBranch;

    /** 目录状态：active/archived */
    @TableField("status")
    private Integer status;

    /** 登记者用户标识 */
    @TableField("created_by_user_id")
    private String createdByUserId;

    /** 登记时间戳（毫秒） */
    @TableField("created_at")
    private LocalDateTime createdAt;

    /** 最近修改时间戳（毫秒） */
    @TableField("updated_at")
    private LocalDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getRepositoryId() {
        return repositoryId;
    }

    public void setRepositoryId(String repositoryId) {
        this.repositoryId = repositoryId;
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

    public String getRemoteUrlSha256() {
        return remoteUrlSha256;
    }

    public void setRemoteUrlSha256(String remoteUrlSha256) {
        this.remoteUrlSha256 = remoteUrlSha256;
    }

    public String getDefaultBranch() {
        return defaultBranch;
    }

    public void setDefaultBranch(String defaultBranch) {
        this.defaultBranch = defaultBranch;
    }

    public Integer getStatus() {
        return status;
    }

    public void setStatus(Integer status) {
        this.status = status;
    }

    public String getCreatedByUserId() {
        return createdByUserId;
    }

    public void setCreatedByUserId(String createdByUserId) {
        this.createdByUserId = createdByUserId;
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
