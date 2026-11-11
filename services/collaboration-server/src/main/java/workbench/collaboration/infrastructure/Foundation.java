package workbench.collaboration.infrastructure;

import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.dao.DuplicateKeyException;
import java.util.*;

/**
 * 数据基础：显式迁移/初始化；普通启动仅校验，不修复、不补回成员。
 * 查自然键 → 只插缺失行 → 全部成功才提交；任何错误回滚，唯一键竞争至多重试一次。
 */
public final class Foundation {
  private final JdbcTemplate jdbc;
  private final TransactionTemplate transaction;
  private final Flyway flyway;
  public Foundation(DataSource source) {
    jdbc = new JdbcTemplate(source);
    jdbc.setQueryTimeout(2);
    transaction = new TransactionTemplate(new JdbcTransactionManager(source));
    flyway = Flyway.configure().dataSource(source).locations("classpath:db/migration")
      .cleanDisabled(true).baselineOnMigrate(false).validateMigrationNaming(true)
      // 不忽略未知迁移；显式空数组同时区分 Flyway 的两个可变参数重载。
      .ignoreMigrationPatterns(new String[0]).load();
  }
  public void migrate() { flyway.migrate(); validate(); }
  /** 启动前同步执行；空库、未知版本和 checksum 不符均抛错，不开放 HTTP。 */
  public void validate() {
    flyway.validate();
    var info = flyway.info();
    if (info.current() == null || info.pending().length != 0 || info.current().getVersion().compareTo(MigrationVersion.fromVersion("003")) != 0)
      throw new IllegalStateException("数据库迁移版本未就绪");
    Integer tables = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ("
      + "'wb_user','wb_workspace','wb_workspace_member',"
      + "'wb_device','wb_device_project','wb_device_request',"
      + "'wb_conversation','wb_message','wb_execution','wb_execution_event','wb_execution_receipt','wb_request_receipt') "
      + "AND engine = 'InnoDB' AND table_collation = 'utf8mb4_unicode_ci'", Integer.class);
    if (!Integer.valueOf(12).equals(tables)) throw new IllegalStateException("业务表引擎或字符集不符合要求");
  }
  /** 只用于显式 init-demo；不会更新已有显示名、停用状态或历史 ID。 */
  public void initializeDemo() {
    for (int attempt = 0; ; attempt++) {
      try { transaction.executeWithoutResult(status -> insertMissing()); return; }
      catch (DuplicateKeyException e) { if (attempt == 1) throw e; }
    }
  }
  private void insertMissing() {
    List<String> users = new ArrayList<>();
    long now = System.currentTimeMillis();
    for (int number = 1; number <= 3; number++) {
      String username = "user%02d".formatted(number);
      List<String> found = jdbc.queryForList("SELECT id FROM wb_user WHERE username = ?", String.class, username);
      String id = found.isEmpty() ? UUID.randomUUID().toString() : found.getFirst();
      if (found.isEmpty()) jdbc.update("INSERT INTO wb_user (id,username,display_name,enabled,created_at_ms) VALUES (?,?,?,?,?)", id, username, "用户 %02d".formatted(number), 1, now);
      users.add(id);
    }
    List<String> found = jdbc.queryForList("SELECT id FROM wb_workspace WHERE slug = ?", String.class, "demo");
    String workspace = found.isEmpty() ? UUID.randomUUID().toString() : found.getFirst();
    if (found.isEmpty()) jdbc.update("INSERT INTO wb_workspace (id,slug,name,created_at_ms) VALUES (?,?,?,?)", workspace, "demo", "演示工作区", now);
    for (String user : users) {
      Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM wb_workspace_member WHERE workspace_id = ? AND user_id = ?", Integer.class, workspace, user);
      if (Integer.valueOf(0).equals(count)) jdbc.update("INSERT INTO wb_workspace_member (workspace_id,user_id,created_at_ms) VALUES (?,?,?)", workspace, user, now);
    }
  }
  /** 有界即时探测；失败交给健康/业务边界映射 503，不据此删除登录身份。 */
  public void ping() { jdbc.queryForObject("SELECT 1", Integer.class); }
}
