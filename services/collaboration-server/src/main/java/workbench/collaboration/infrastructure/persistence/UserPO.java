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
 * 业务全局唯一标识 id (UUID) 与底层物理自增主键 pk_id 严格解耦。
 *
 * <p>【协作边界】
 * - 上游调用方：UserMapper、IdentityConverter、IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_user")
public class UserPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 用户全局唯一业务标识 (UUID) */
    @TableField("id")
    private String id;

    /** 登录用户名（唯一） */
    @TableField("username")
    private String username;

    /** 展示名称 */
    @TableField("display_name")
    private String displayName;

    /** 账号启用状态（1: 启用, 0: 禁用） */
    @TableField("enabled")
    private Integer enabled;

    /** 创建时间戳（毫秒） */
    @TableField("created_at")
    private LocalDateTime createdAt;

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

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
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
}
