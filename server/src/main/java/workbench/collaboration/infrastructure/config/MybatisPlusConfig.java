package workbench.collaboration.infrastructure.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.support.JdbcTransactionManager;

import javax.sql.DataSource;

/**
 * 模块：MyBatis-Plus 持久层与事务配置 (MybatisPlusConfig)
 *
 * <p>【功能定义】
 * 配置 Spring 统一的事务管理器（JdbcTransactionManager），为 MyBatis-Plus 与底层短事务提供单一事务事实源。
 * 避免出现多个事务管理器引起的事务失效或连接泄漏。
 *
 * <p>【架构协作约定】
 * - 唯一的 Hikari 数据源与该事务管理器绑定；
 * - Mapper 接口由启动类 Application 上的 @MapperScan 统一扫描，此处不重复注册；
 * - MyBatis-Plus 的 SqlSessionFactory 由 starter 自动装配。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring 容器事务切面、ConversationAppService 短事务模板。
 * - 下游依赖方：DataSource、JdbcTransactionManager。
 */
@Configuration
public class MybatisPlusConfig {

    /**
     * 注册主事务管理器。
     *
     * @param dataSource HikariCP 物理数据源
     * @return 事务管理器实例
     */
    @Bean
    @Primary
    JdbcTransactionManager transactionManager(DataSource dataSource) {
        return new JdbcTransactionManager(dataSource);
    }
}
