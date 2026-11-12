package workbench.collaboration.infrastructure.contract;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;

import javax.sql.DataSource;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 模块：数据库基础设施校验与运维引导 (Foundation)
 *
 * <p>【功能定义】
 * 负责 TDSQL 底层数据库结构的启动期只读核对，以及演示环境数据初始化。
 * 本服务从不执行任何 DDL——库表结构唯一来源是 classpath:db/schema.sql，由运维手工建库。
 *
 * <p>【核心架构底线与校验规则 (Invariants)】
 * 1. 严格 11 张控制面小表（HC-211 组织层模型）：
 *    - 必须存在 wb_user、wb_workspace、wb_workspace_member、wb_device、wb_repository、
 *      wb_project、wb_project_member、wb_project_repository、wb_local_repo_binding、
 *      wb_conversation、wb_conversation_repository；
 *    - 引擎必须为 InnoDB，字符集必须为 utf8mb4；
 *    - 每张业务表必须拥有物理自增主键 bigint unsigned pk_id (PRI auto_increment)；
 *    - 抽查新语义关键列：wb_device.owner_user_id、wb_conversation 的 owner/status/brief/synced_sequence 等；
 * 2. 彻底移除旧模型残留：
 *    - 绝不允许出现历史流水表（wb_message、wb_execution 系列、wb_request_receipt、
 *      wb_device_request、wb_outbox_event）；
 *    - 绝不允许出现旧协作模型表 wb_device_project、wb_handoff、wb_message_reference；
 *    - wb_device 不得再有 workspace_id 列（设备属人不属团队，D11）；
 *    - wb_conversation 不得再有 current_user_id/active_execution_id/next_sequence/created_by_user_id 旧列。
 *    一旦探测到残留立即拒绝服务启动。
 *
 * <p>【协作边界】
 * - 上游调用方：Application 启动引导器、ServerConfiguration。
 * - 下游依赖方：JdbcTemplate、IdentityRepository。
 */
public final class Foundation {

    /** 必须存在的 11 张控制面表 */
    private static final List<String> REQUIRED_TABLES = List.of(
            "wb_user", "wb_workspace", "wb_workspace_member", "wb_device",
            "wb_repository", "wb_project", "wb_project_member", "wb_project_repository",
            "wb_local_repo_binding", "wb_conversation", "wb_conversation_repository"
    );

    /** 新语义关键列抽查清单：表 -> 必须存在的列 */
    private static final Map<String, List<String>> REQUIRED_COLUMNS = Map.of(
            "wb_device", List.of("owner_user_id"),
            "wb_repository", List.of("remote_url", "status"),
            "wb_project", List.of("owner_user_id", "version"),
            "wb_conversation", List.of("project_id", "owner_user_id", "status", "brief_source", "synced_sequence"),
            "wb_local_repo_binding", List.of("device_id", "repository_id"),
            "wb_conversation_repository", List.of("conversation_id", "repository_id")
    );

    /** 严禁存在的已废弃表集合（历史流水表 + 旧协作模型表，防架构倒退） */
    private static final List<String> REMOVED_TABLES = List.of(
            "wb_message", "wb_execution", "wb_execution_event", "wb_execution_receipt",
            "wb_request_receipt", "wb_device_request", "wb_outbox_event",
            "wb_device_project", "wb_handoff", "wb_message_reference"
    );

    /** 严禁残留的旧语义列：表 -> 禁止列 */
    private static final Map<String, List<String>> REMOVED_COLUMNS = Map.of(
            "wb_device", List.of("workspace_id"),
            "wb_conversation", List.of("created_by_user_id", "current_user_id", "active_execution_id", "next_sequence")
    );

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final IdentityRepository identity;

    public Foundation(DataSource source, JdbcTransactionManager transactions, IdentityRepository identity) {
        this.jdbc = new JdbcTemplate(source);
        this.jdbc.setQueryTimeout(2);
        this.transaction = new TransactionTemplate(transactions);
        this.identity = identity;
    }

    // 测试接缝：直接注入 JdbcTemplate，便于用内存替身核对校验清单，生产装配仍走上面的构造器
    Foundation(JdbcTemplate jdbc, TransactionTemplate transaction, IdentityRepository identity) {
        this.jdbc = jdbc;
        this.transaction = transaction;
        this.identity = identity;
    }

    /**
     * 启动期只读核对数据库结构是否完全满足规范。
     * 收集全部缺失表、缺失列、违规残留后一次性打印清单并抛出 IllegalStateException 阻止启动；
     * 绝不执行任何 DDL。
     */
    public void validate() {
        List<String> problems = new ArrayList<>();

        // 逐表核对存在性、引擎、字符集与自增主键
        for (String table : REQUIRED_TABLES) {
            Integer ok = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?"
                            + " AND engine = 'InnoDB' AND table_collation LIKE 'utf8mb4%'",
                    Integer.class, table
            );
            if (!Integer.valueOf(1).equals(ok)) {
                problems.add("缺失合规表: " + table);
                continue;
            }
            Integer key = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?"
                            + " AND column_name = 'pk_id' AND column_type = 'bigint unsigned' AND column_key = 'PRI' AND extra LIKE '%auto_increment%'",
                    Integer.class, table
            );
            if (!Integer.valueOf(1).equals(key)) {
                problems.add("表缺少自增物理主键 pk_id: " + table);
            }
            for (String column : REQUIRED_COLUMNS.getOrDefault(table, List.of())) {
                Integer columnOk = jdbc.queryForObject(
                        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
                        Integer.class, table, column
                );
                if (!Integer.valueOf(1).equals(columnOk)) {
                    problems.add("表缺少必需列: " + table + "." + column);
                }
            }
        }

        // 防御旧表与旧列残留
        for (String table : REMOVED_TABLES) {
            Integer stale = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
                    Integer.class, table
            );
            if (Integer.valueOf(1).equals(stale)) {
                problems.add("存在已废弃表: " + table);
            }
        }
        REMOVED_COLUMNS.forEach((table, columns) -> columns.forEach(column -> {
            Integer stale = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
                    Integer.class, table, column
            );
            if (Integer.valueOf(1).equals(stale)) {
                problems.add("存在已废弃列: " + table + "." + column);
            }
        }));

        if (!problems.isEmpty()) {
            StringBuilder report = new StringBuilder("数据库结构不符合协作模型规范（应用从不执行 DDL，请按 db/schema.sql 手工建库）：\n");
            problems.forEach(problem -> report.append("  - ").append(problem).append('\n'));
            System.err.print(report);
            throw new IllegalStateException("数据库结构校验失败，共 " + problems.size() + " 项问题");
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
