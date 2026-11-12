package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

/**
 * 模块：设备档案表持久化对象 (DevicePO)
 *
 * <p>【功能定义】
 * 映射 TDSQL 表 wb_device 的持久化实体。
 * 严格记录本机设备的注册备案信息与凭据摘要（SHA-256），
 * 设备在线心跳存储于 Redis（wb:device:hb:*），绝不写入本表。
 * HC-211 起设备属于用户本人，表内不再保留 workspace_id。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceMapper、DeviceConverter、DeviceRepositoryImpl。
 * - 下游依赖方：MyBatis-Plus 注解体系。
 */
@TableName("wb_device")
public class DevicePO {

    /** 物理聚簇自增主键 */
    @TableId(value = "pk_id", type = IdType.AUTO)
    private Long pkId;

    /** 设备全局唯一业务标识 (UUID) */
    @TableField("id")
    private String id;

    /** 设备所属用户标识 */
    @TableField("owner_user_id")
    private String ownerUserId;

    /** 本地客户端安装实例标识 */
    @TableField("installation_id")
    private String installationId;

    /** 本地客户端账本标识 */
    @TableField("ledger_id")
    private String ledgerId;

    /** 设备展示名称 */
    @TableField("name")
    private String name;

    /** 客户端凭据的 SHA-256 哈希值（不存明文） */
    @TableField("secret_sha256")
    private String secretSha256;

    /** 首次注册请求标识 */
    @TableField("registration_id")
    private String registrationId;

    /** 首次注册报文主体的 SHA-256 哈希 */
    @TableField("registration_body_sha256")
    private String registrationBodySha256;

    /** 是否已吊销注销（1: 已吊销, 0: 正常） */
    @TableField("revoked")
    private Integer revoked;

    /** 注册时间戳（毫秒） */
    @TableField("created_at_ms")
    private Long createdAtMs;

    /** 最近一次更新时间戳（毫秒） */
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

    public String getOwnerUserId() {
        return ownerUserId;
    }

    public void setOwnerUserId(String ownerUserId) {
        this.ownerUserId = ownerUserId;
    }

    public String getInstallationId() {
        return installationId;
    }

    public void setInstallationId(String installationId) {
        this.installationId = installationId;
    }

    public String getLedgerId() {
        return ledgerId;
    }

    public void setLedgerId(String ledgerId) {
        this.ledgerId = ledgerId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getSecretSha256() {
        return secretSha256;
    }

    public void setSecretSha256(String secretSha256) {
        this.secretSha256 = secretSha256;
    }

    public String getRegistrationId() {
        return registrationId;
    }

    public void setRegistrationId(String registrationId) {
        this.registrationId = registrationId;
    }

    public String getRegistrationBodySha256() {
        return registrationBodySha256;
    }

    public void setRegistrationBodySha256(String registrationBodySha256) {
        this.registrationBodySha256 = registrationBodySha256;
    }

    public Integer getRevoked() {
        return revoked;
    }

    public void setRevoked(Integer revoked) {
        this.revoked = revoked;
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
