package workbench.collaboration.infrastructure.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;

/** application.yml 的 workbench.* 要能绑到配置对象上，不启动数据库。 */
class WorkbenchPropertiesTest {
  private final ApplicationContextRunner runner = new ApplicationContextRunner()
    .withUserConfiguration(Enable.class);

  @Test
  void bindsCommandAndOrigin() {
    runner.withPropertyValues("workbench.command=migrate", "workbench.origin=http://127.0.0.1:18084")
      .run(context -> {
        WorkbenchProperties properties = context.getBean(WorkbenchProperties.class);
        assertThat(properties.getCommand()).isEqualTo("migrate");
        assertThat(properties.getOrigin()).isEqualTo("http://127.0.0.1:18084");
      });
  }

  @Configuration
  @EnableConfigurationProperties(WorkbenchProperties.class)
  static class Enable {}
}
