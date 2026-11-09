package workbench.collaboration.infrastructure;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/** 线上时间只使用三位毫秒 UTC Z 字符串；SQL epoch 毫秒仅在数据层转换。 */
public final class TimeCodec {
  private static final DateTimeFormatter FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
  private TimeCodec() {}
  public static String utc(long epochMs) { return FORMAT.format(Instant.ofEpochMilli(epochMs)); }
  /** 已由 schema 校验格式；这里只做严格解析，失败即协议错误。 */
  public static long epoch(String utc) { return Instant.parse(utc).toEpochMilli(); }
}
