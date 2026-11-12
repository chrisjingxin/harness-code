package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.LocalDateTime;

/**
 * 模块：设备本机仓库登记表持久化对象 (LocalRepoBindingPO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_local_repo_binding 的持久化实体。
 * 只存 device_id + repository_id 关联事实——本地绝对路径只存本机（隐私边界）。
 *
 * <p>【协作边界】
 * - 上游调用方：LocalRepoBindingMapper、RepositoryConverter、LocalRepoBindingRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_local_repo_binding")
public class LocalRepoBindingPO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 登记设备标识 */
    @TableField("device_id")
    private String deviceId;

    /** 团队仓库目录条目标识 */
    @TableField("repository_id")
    private String repositoryId;

    /** 最近一次登记时间戳（毫秒，重复 upsert 刷新） */
    @TableField("created_at")
    private LocalDateTime createdAt;

    public Long getPkId() {
        return pkId;
    }

    public void setPkId(Long pkId) {
        this.pkId = pkId;
    }

    public String getDeviceId() {
        return deviceId;
    }

    public void setDeviceId(String deviceId) {
        this.deviceId = deviceId;
    }

    public String getRepositoryId() {
        return repositoryId;
    }

    public void setRepositoryId(String repositoryId) {
        this.repositoryId = repositoryId;
    }

    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
