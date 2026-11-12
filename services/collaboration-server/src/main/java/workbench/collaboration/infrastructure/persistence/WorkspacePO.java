package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：工作区表持久化对象 (WorkspacePO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_workspace 的持久化实体。
 * 保存工作区业务标识、slug 短别名与展示名称。
 *
 * <p>【协作边界】
 * - 上游调用方：WorkspaceMapper、IdentityConverter、IdentityRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_workspace")
public class WorkspacePO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 工作区全局唯一业务标识 (UUID) */
    @TableField("id")
    private String id;

    /** 工作区友好别名（URL Slug） */
    @TableField("slug")
    private String slug;

    /** 工作区展示名称 */
    @TableField("name")
    private String name;

    /** 创建时间戳（毫秒） */
    @TableField("created_at_ms")
    private Long createdAtMs;

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

    public String getSlug() {
        return slug;
    }

    public void setSlug(String slug) {
        this.slug = slug;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Long getCreatedAtMs() {
        return createdAtMs;
    }

    public void setCreatedAtMs(Long createdAtMs) {
        this.createdAtMs = createdAtMs;
    }
}
