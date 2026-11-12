package workbench.collaboration.infrastructure.contract;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/**
 * 模块：时间戳编解码转换器 (TimeCodec)
 *
 * <p>【功能定义】
 * 规范平台对外 HTTP 接口与 JSON 契约中的统一时间格式。
 * 遵循严格契约标准：网络传输中一律强制采用三位毫秒精度的 UTC 'Z' 格式字符串（yyyy-MM-dd'T'HH:mm:ss.SSS'Z'）；
 * 数据库层与内部模型中则统一使用标准 Unix Epoch 毫秒长整型（long）。
 *
 * <p>【协作边界】
 * - 上游调用方：全系统 DTO 装配层、实体转换层与事件编码器。
 * - 下游依赖方：Java 原生 java.time 标准库，零第三方时间依赖。
 */
public final class TimeCodec {

    private static final DateTimeFormatter FORMAT = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC);

    private TimeCodec() {}

    /**
     * 将 Unix Epoch 毫秒时间戳格式化为标准的 UTC 'Z' 字符串。
     *
     * @param epochMs 毫秒时间戳
     * @return 符合 ISO-8601 标准的 UTC 格式字符串（如 "2026-11-12T09:12:00.000Z"）
     */
    public static String utc(long epochMs) {
        return FORMAT.format(Instant.ofEpochMilli(epochMs));
    }

    /**
     * 将符合 Schema 约束的 UTC 'Z' 时间字符串反解析为 Unix Epoch 毫秒长整型。
     *
     * <p>【契约不变量 (Invariants)】
     * 入参时间字符串已在前置 JSON Schema 校验中通过格式检验；
     * 此处执行严格解析，若发生解析异常则视为严重协议破坏直接抛出异常。
     *
     * @param utc UTC 格式时间字符串
     * @return 毫秒时间戳
     */
    public static long epoch(String utc) {
        return Instant.parse(utc).toEpochMilli();
    }
}
