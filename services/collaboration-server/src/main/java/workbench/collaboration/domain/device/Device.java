package workbench.collaboration.domain.device;

/**
 * 模块：设备实体模型 (Device)
 *
 * <p>【功能定义】
 * 表示在协作平台上登记备案的本机执行设备档案。
 * 记录设备凭据哈希（SHA-256 安全脱敏，不存明文）、绑定用户与有效状态。
 * HC-211 起设备属于用户本人（D11），不再绑定工作区：
 * 同一用户的设备可在任意其所在团队的项目中登记本地仓库与会话同步。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、DeviceRepository、DeviceConverter。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param id 设备全局唯一标识 (UUID)
 * @param ownerUserId 设备所有者用户标识
 * @param installationId 客户端本地安装实例标识
 * @param ledgerId 客户端本地状态账本标识
 * @param name 用户为设备起的显示别名
 * @param secretSha256 客户端访问凭据（Secret）的 SHA-256 摘要（杜绝明文凭据入库泄漏）
 * @param registrationId 设备初次注册请求标识（用于幂等重放校验）
 * @param registrationBodySha256 注册报文主体的哈希校验和
 * @param revoked 设备是否已被吊销禁用（true 表示已被注销，禁止上传与同步）
 * @param createdAtMs 注册时间戳（毫秒）
 * @param updatedAtMs 最近修改时间戳（毫秒）
 */
public record Device(
        String id,
        String ownerUserId,
        String installationId,
        String ledgerId,
        String name,
        String secretSha256,
        String registrationId,
        String registrationBodySha256,
        boolean revoked,
        long createdAtMs,
        long updatedAtMs
) {}
