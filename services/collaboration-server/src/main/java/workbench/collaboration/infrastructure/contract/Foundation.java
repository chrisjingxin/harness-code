package workbench.collaboration.infrastructure.contract;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;

import javax.sql.DataSource;
import java.util.UUID;

/**
 * 模块：数据库基础设施校验与运维引导 (Foundation)
 *
 * <p>【功能定义】
 * 负责 TDSQL 底层数据库结构的 Flyway 版本迁移、表结构合规性静态探测以及演示环境数据初始化。
 *
 * <p>【核心架构底线与校验规则 (Invariants)】
 * 1. 严格 6 张核心控制面小表：
 *    - 仅允许存在 wb_user、wb_workspace、wb_workspace_member、wb_device、wb_device_project、wb_conversation；
 *    - 引擎必须为 InnoDB，字符集必须为 utf8mb4_unicode_ci；
 *    - 每张业务表必须拥有物理自增主键 bigint unsigned pk_id (PRI auto_increment)；
 * 2. 彻底移除海量流水膨胀表：
 *    - 绝不允许再出现 wb_message、wb_execution、wb_execution_event、wb_execution_receipt、
 *      wb_request_receipt、wb_device_request、wb_outbox_event；一旦探测到存在立即拒绝服务启动。
 *
 * <p>【协作边界】
 * - 上游调用方：Application 启动引导器、ServerConfiguration。
 * - 下游依赖方：Flyway、JdbcTemplate、IdentityRepository。
 */
public final class Foundation {

    /** 允许存在的 6 张控制面表名集合 */
    private static final String TABLES = "'wb_user','wb_workspace','wb_workspace_member','wb_device','wb_device_project','wb_conversation'";

    /** 严禁存在的已废弃流水表名集合（防架构倒退） */
    private static final String REMOVED = "'wb_message','wb_execution','wb_execution_event','wb_execution_receipt','wb_request_receipt','wb_device_request','wb_outbox_event'";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final IdentityRepository identity;
    private final Flyway flyway;

    public Foundation(DataSource source, JdbcTransactionManager transactions, IdentityRepository identity) {
        this.jdbc = new JdbcTemplate(source);
        this.jdbc.setQueryTimeout(2);
        this.transaction = new TransactionTemplate(transactions);
        this.identity = identity;
        this.flyway = Flyway.configure()
                .dataSource(source)
                .locations("classpath:db/migration")
                .cleanDisabled(true)
                .baselineOnMigrate(false)
                .validateMigrationNaming(true)
                .ignoreMigrationPatterns(new String[0])
                .load();
    }

    /**
     * 执行数据库迁移，并在迁移完成后严格执行架构规范自检。
     */
    public void migrate() {
        flyway.migrate();
        validate();
    }

    /**
     * 强校验数据库结构是否完全满足高可用架构规范。
     * 空库、迁移版本不符、缺失自增主键、或残留已废弃流水表均会直接抛出 IllegalStateException 阻止启动。
     */
    public void validate() {
        flyway.validate();
        var info = flyway.info();
        if (info.current() == null || info.pending().length != 0 || info.current().getVersion().compareTo(MigrationVersion.fromVersion("003")) != 0) {
            throw new IllegalStateException("数据库迁移版本未就绪");
        }

        // 校验 6 张控制面表的存储引擎与字符集规范
        Integer tables = jdbc.queryForObject(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ("
                        + TABLES + ") AND engine = 'InnoDB' AND table_collation = 'utf8mb4_unicode_ci'",
                Integer.class
        );
        if (!Integer.valueOf(6).equals(tables)) {
            throw new IllegalStateException("业务表引擎或字符集不符合要求");
        }

        // 校验每张表是否都具备自增物理主键 pk_id
        Integer keys = jdbc.queryForObject(
                "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN ("
                        + TABLES + ") AND column_name = 'pk_id' AND column_type = 'bigint unsigned' AND column_key = 'PRI' AND extra LIKE '%auto_increment%'",
                Integer.class
        );
        if (!Integer.valueOf(6).equals(keys)) {
            throw new IllegalStateException("业务表缺少自增物理主键");
        }

        // 坚决防御流水表回归
        Integer removed = jdbc.queryForObject(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ("
                        + REMOVED + ")",
                Integer.class
        );
        if (!Integer.valueOf(0).equals(removed)) {
            throw new IllegalStateException("数据库仍有已删除的流水表");
        }
    }

    /**
     * 初始化演示环境的基础数据（用户与工作区）。
     * 具备幂等并发重试防护，支持在并发启动时安全避让主键冲突。
     */
    public void initializeDemo() {
        for (int attempt = 0; ; attempt++) {
            try {
                transaction.executeWithoutResult(status -> insertMissing());
                return;
            } catch (DuplicateKeyException conflict) {
                if (attempt == 1) {
                    throw conflict;
                }
            }
        }
    }

    private void insertMissing() {
        long now = System.currentTimeMillis();
        String[] userIds = new String[3];
        for (int number = 1; number <= 3; number++) {
            String username = "user%02d".formatted(number);
            var found = identity.findUserByUsername(username);
            if (found.isEmpty()) {
                String id = UUID.randomUUID().toString();
                identity.insertUser(new User(id, username, "用户 %02d".formatted(number), true, now));
                userIds[number - 1] = id;
            } else {
                userIds[number - 1] = found.get().id();
            }
        }
        var workspace = identity.findWorkspaceBySlug("demo");
        String workspaceId = workspace.map(Workspace::id).orElseGet(() -> {
            String id = UUID.randomUUID().toString();
            identity.insertWorkspace(new Workspace(id, "demo", "演示工作区", now));
            return id;
        });
        for (String userId : userIds) {
            if (!identity.memberExists(workspaceId, userId)) {
                identity.insertMember(new WorkspaceMember(workspaceId, userId, now));
            }
        }
    }

    /**
     * 数据库实时心跳探测，供健康检查端点快速测试数据库连通性。
     */
    public void ping() {
        jdbc.queryForObject("SELECT 1", Integer.class);
    }
}
