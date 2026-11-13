package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

/**
 * 模块：用户表持久化对象 (UserPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_user 的持久化实体。
 * 业务全局唯一标识 user_id (UUID) 与底层物理自增主键 id 严格解耦，并承载用户工号、姓名、头像与所属机构路径。
 *
 * <p>【协作边界】
 * - 上游调用方：UserMapper、IdentityConverter、IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_user")
public class UserPO {

    /** 物理主键（BIGINT UNSIGNED AUTO_INCREMENT） */
    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    /** 用户全局唯一业务标识 (UUID) */
    @TableField("user_id")
    private String userId;

    /** 员工工号/一号通标识（如 80278667，未绑定为空串） */
    @TableField("user_no")
    private String userNo;

    /** 用户名称 */
    @TableField("user_name")
    private String userName;

    /** 用户头像 URL（未设置为空串） */
    @TableField("photo")
    private String photo;

    /** 所属内部机构 ID */
    @TableField("org_id")
    private String orgId;

    /** 所属外部机构 ID */
    @TableField("org_no")
    private String orgNo;

    /** 所属机构名称 */
    @TableField("org_name")
    private String orgName;

    /** 内部机构路径 ID */
    @TableField("org_path_id")
    private String orgPathId;

    /** 外部机构路径 ID */
    @TableField("org_path_no")
    private String orgPathNo;

    /** 机构路径名称 */
    @TableField("org_path_name")
    private String orgPathName;

    /** 账号启用状态（1: 启用, 0: 停用） */
    @TableField("enabled")
    private Integer enabled;

    /** 创建时间 */
    @TableField("created_at")
    private LocalDateTime createdAt;

    /** 最近更新时间 */
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

    public String getUserNo() {
        return userNo;
    }

    public void setUserNo(String userNo) {
        this.userNo = userNo;
    }

    public String getUserName() {
        return userName;
    }

    public void setUserName(String userName) {
        this.userName = userName;
    }

    public String getPhoto() {
        return photo;
    }

    public void setPhoto(String photo) {
        this.photo = photo;
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

    public Integer getEnabled() {
        return enabled;
    }

    public void setEnabled(Integer enabled) {
        this.enabled = enabled;
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
