package workbench.collaboration;

import com.zaxxer.hikari.*;
import javax.sql.DataSource;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.bind.*;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import workbench.collaboration.infrastructure.Foundation;
import java.util.Map;

/** 单应用的数据装配；命令决定迁移/初始化/启动，绝不在普通启动时写入演示数据。 */
@SpringBootConfiguration
@EnableAutoConfiguration
public class ServerConfiguration {
  @Bean Contracts contracts() { return new Contracts(); }
  @Bean(destroyMethod = "close") HikariDataSource dataSource(Environment env) {
    HikariConfig config = new HikariConfig();
    config.setJdbcUrl(env.getRequiredProperty("spring.datasource.url"));
    config.setUsername(env.getRequiredProperty("spring.datasource.username"));
    config.setPassword(env.getRequiredProperty("spring.datasource.password"));
    config.setMaximumPoolSize(4); config.setMinimumIdle(0);
    config.setConnectionTimeout(3000); config.setValidationTimeout(1000); config.setInitializationFailTimeout(5000);
    Binder.get(env).bind("spring.datasource.hikari.data-source-properties", Bindable.mapOf(String.class, String.class)).orElse(Map.of()).forEach(config::addDataSourceProperty);
    return new HikariDataSource(config);
  }
  @Bean Foundation foundation(DataSource source, Contracts contracts, Environment env) {
    Foundation foundation = new Foundation(source);
    switch (env.getRequiredProperty("workbench.command")) {
      case "migrate" -> foundation.migrate();
      case "init-demo" -> { foundation.validate(); foundation.initializeDemo(); }
      case "start" -> foundation.validate();
      default -> throw new IllegalArgumentException("未知服务端命令");
    }
    return foundation;
  }
}
