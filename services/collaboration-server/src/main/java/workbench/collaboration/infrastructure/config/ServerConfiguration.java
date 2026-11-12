package workbench.collaboration.infrastructure.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.support.JdbcTransactionManager;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.Foundation;

import javax.sql.DataSource;
import java.util.Map;

/**
 * 模块：服务端核心组件装配配置 (ServerConfiguration)
 *
 * <p>【功能定义】
 * 装配服务全局单例 Contracts 契约校验中心、高性能 HikariCP 物理数据源，
 * 并依据命令行引导参数驱动 Foundation 初始化演示数据（init-demo）或仅校验结构启动（start）。
 *
 * <p>【数据库连接池调优设计 (Why)】
 * - 启用 MySQL 服务端预编译缓存（cachePrepStmts=true、prepStmtCacheSize=250、prepStmtCacheSqlLimit=2048）；
 * - 高频短事务反复执行 wb_conversation lockById 等模板 SQL 时，无需在连接级别重复编译解析，大幅降低 MySQL CPU 开销。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring Boot 上下文。
 * - 下游依赖方：HikariDataSource、Foundation、Contracts。
 */
@Configuration
public class ServerConfiguration {

    @Bean
    Contracts contracts() {
        return new Contracts();
    }

    /**
     * 构建并初始化 HikariCP 数据库连接池。
     */
    @Bean(destroyMethod = "close")
    HikariDataSource dataSource(Environment env, WorkbenchProperties properties) {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(env.getRequiredProperty("spring.datasource.url"));
        config.setUsername(env.getRequiredProperty("spring.datasource.username"));
        config.setPassword(env.getRequiredProperty("spring.datasource.password"));

        WorkbenchProperties.Pool pool = properties.getPool();
        config.setMaximumPoolSize(pool.getMaximumSize());
        config.setMinimumIdle(pool.getMinimumIdle());
        config.setConnectionTimeout(pool.getConnectionTimeoutMs());
        config.setValidationTimeout(pool.getValidationTimeoutMs());
        config.setInitializationFailTimeout(pool.getInitializationFailTimeoutMs());

        // 预编译语句物理连接缓存优化：短事务反复走同一条 SQL 时不必每次重新向数据库申请准备
        config.addDataSourceProperty("cachePrepStmts", "true");
        config.addDataSourceProperty("prepStmtCacheSize", "250");
        config.addDataSourceProperty("prepStmtCacheSqlLimit", "2048");
        config.addDataSourceProperty("useServerPrepStmts", "true");

        Binder.get(env).bind("spring.datasource.hikari.data-source-properties", Bindable.mapOf(String.class, String.class))
                .orElse(Map.of())
                .forEach(config::addDataSourceProperty);

        return new HikariDataSource(config);
    }

    /**
     * 装配数据库基础验证器，并依据启动命令执行相应的生命周期动作。
     */
    @Bean
    Foundation foundation(
            DataSource source,
            JdbcTransactionManager transactions,
            IdentityRepository identity,
            Environment env
    ) {
        Foundation foundation = new Foundation(source, transactions, identity);
        switch (env.getRequiredProperty("workbench.command")) {
            case "init-demo" -> {
                foundation.validate();
                foundation.initializeDemo();
            }
            case "start" -> foundation.validate();
            default -> throw new IllegalArgumentException("未知服务端命令");
        }
        return foundation;
    }
}
