package workbench.collaboration.infrastructure.contract;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 模块：SHA-256 摘要工具 (Digests)
 *
 * <p>【功能定义】
 * 提供请求体指纹、设备密钥等场景通用的 SHA-256 十六进制摘要计算。
 * 替代已拆除的 ExecutionCodec 中唯一仍被需要的纯哈希能力。
 *
 * <p>【协作边界】
 * - 上游调用方：IdempotentCalls、DeviceAppService。
 * - 下游依赖方：JDK MessageDigest。
 */
public final class Digests {

    private Digests() {}

    /**
     * 计算任意字符串基于 UTF-8 编码的 SHA-256 十六进制摘要。
     *
     * @param value 输入字符串
     * @return 64 位小写十六进制字符串
     */
    public static String sha256Hex(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }
}
