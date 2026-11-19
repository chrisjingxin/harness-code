package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

/**
 * 模块：用户机构关系表持久化对象 (UserOrgPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_user_org 的持久化实体，记录用户与机构间的主/兼岗归属与有效性状态。
 *
 * <p>【协作边界】
 * - 上游调用方：UserOrgMapper、IdentityConverter、IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_user_org")
public class UserOrgPO {

    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    @TableField("user_id")
    private String userId;

    @TableField("position_type")
    private Integer positionType;

    @TableField("org_id")
    private String orgId;

    @TableField("org_no")
    private String orgNo;

    @TableField("org_name")
    private String orgName;

    @TableField("org_path_id")
    private String orgPathId;

    @TableField("org_path_no")
    private String orgPathNo;

    @TableField("org_path_name")
    private String orgPathName;

    @TableField("status")
    private Integer status;

    @TableField("created_at")
    private LocalDateTime createdAt;

    @TableField("updated_at")
    private LocalDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public Integer getPositionType() {
        return positionType;
    }

    public void setPositionType(Integer positionType) {
        this.positionType = positionType;
    }

    public String getOrgId() {
        return orgId;
    }

    public void setOrgId(String orgId) {
        this.orgId = orgId;
    }

    public String getOrgNo() {
        return orgNo;
    }

    public void setOrgNo(String orgNo) {
        this.orgNo = orgNo;
    }

    public String getOrgName() {
        return orgName;
    }

    public void setOrgName(String orgName) {
        this.orgName = orgName;
    }

    public String getOrgPathId() {
        return orgPathId;
    }

    public void setOrgPathId(String orgPathId) {
        this.orgPathId = orgPathId;
    }

    public String getOrgPathNo() {
        return orgPathNo;
    }

    public void setOrgPathNo(String orgPathNo) {
        this.orgPathNo = orgPathNo;
    }

    public String getOrgPathName() {
        return orgPathName;
    }

    public void setOrgPathName(String orgPathName) {
        this.orgPathName = orgPathName;
    }

    public Integer getStatus() {
        return status;
    }

    public void setStatus(Integer status) {
        this.status = status;
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
