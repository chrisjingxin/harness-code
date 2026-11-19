package workbench.collaboration.infrastructure.persistence;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * 模块：持久层时间互转工具 (Times)
 *
 * <p>【功能定义】
 * TDSQL 时间列统一使用 DATETIME(3)（当前时区墙钟，毫秒精度），
 * 领域层与对外契约继续使用 epoch 毫秒 long。本工具负责两者互转。
 * DATETIME 不存时区：读写两端一律按应用默认时区解释，
 * 要求 JDBC 会话时区与应用时区一致（同一 JVM 进程内天然成立）。
 *
 * <p>【协作边界】
 * - 上游调用方：各 PO Converter、RepositoryImpl 游标条件构造。
 * - 下游依赖方：JDK Instant/LocalDateTime。
 */
final class Times {

    private Times() {}

    /** epoch 毫秒转 DATETIME(3) 当前时区墙钟 */
    static LocalDateTime ofMs(long epochMs) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(epochMs), ZoneId.systemDefault());
    }

    /** DATETIME(3) 当前时区墙钟转 epoch 毫秒 */
    static long ms(LocalDateTime dateTime) {
        return dateTime.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
    }
}
