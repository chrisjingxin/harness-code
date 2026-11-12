package workbench.collaboration.infrastructure.persistence;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;

/**
 * 模块：持久层时间互转工具 (Times)
 *
 * <p>【功能定义】
 * TDSQL 时间列统一使用 DATETIME(3)（UTC 墙钟，毫秒精度），
 * 领域层与对外契约继续使用 epoch 毫秒 long。本工具负责两者互转。
 * DATETIME 不带时区，读写两端一律按 UTC 解释，任何环节不得混入系统默认时区。
 *
 * <p>【协作边界】
 * - 上游调用方：各 PO Converter、RepositoryImpl 游标条件构造。
 * - 下游依赖方：JDK Instant/LocalDateTime。
 */
final class Times {

    private Times() {}

    /** epoch 毫秒转 DATETIME(3) UTC 墙钟 */
    static LocalDateTime ofMs(long epochMs) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(epochMs), ZoneOffset.UTC);
    }

    /** DATETIME(3) UTC 墙钟转 epoch 毫秒 */
    static long ms(LocalDateTime dateTime) {
        return dateTime.toInstant(ZoneOffset.UTC).toEpochMilli();
    }
}
