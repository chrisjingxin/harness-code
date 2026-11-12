package workbench.collaboration.infrastructure.persistence;

import workbench.collaboration.domain.device.Device;

/**
 * 模块：设备持久化对象与领域模型转换器 (DeviceConverter)
 *
 * <p>【功能定义】
 * 提供 Device 领域实体与 DevicePO 表持久化对象之间的双向转换。
 * 负责布尔属性与数据库 TINYINT(1) 整型之间的确定性映射。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceRepositoryImpl。
 * - 下游依赖方：Device、DevicePO。
 */
final class DeviceConverter {

    private DeviceConverter() {}

    static DevicePO toPo(Device device) {
        DevicePO po = new DevicePO();
        po.setId(device.id());
        po.setOwnerUserId(device.ownerUserId());
        po.setInstallationId(device.installationId());
        po.setLedgerId(device.ledgerId());
        po.setName(device.name());
        po.setSecretSha256(device.secretSha256());
        po.setRegistrationId(device.registrationId());
        po.setRegistrationBodySha256(device.registrationBodySha256());
        po.setRevoked(device.revoked() ? 1 : 0);
        po.setCreatedAtMs(device.createdAtMs());
        po.setUpdatedAtMs(device.updatedAtMs());
        return po;
    }

    static Device toDevice(DevicePO po) {
        return new Device(
                po.getId(),
                po.getOwnerUserId(),
                po.getInstallationId(),
                po.getLedgerId(),
                po.getName(),
                po.getSecretSha256(),
                po.getRegistrationId(),
                po.getRegistrationBodySha256(),
                Integer.valueOf(1).equals(po.getRevoked()),
                po.getCreatedAtMs(),
                po.getUpdatedAtMs()
        );
    }
}
