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
        assertThat(properties.getMiddleware().getMode()).isEqualTo("cluster");
        assertThat(properties.cluster()).isFalse();
      });
  }

  @Test
  void defaultsToClusterOnlyWhenStartCommandRuns() {
    runner.run(context -> {
      WorkbenchProperties properties = context.getBean(WorkbenchProperties.class);
      assertThat(properties.getMiddleware().getMode()).isEqualTo("cluster");
      assertThat(properties.cluster()).isTrue();
    });
    runner.withPropertyValues("workbench.command=init-demo").run(context -> {
      WorkbenchProperties properties = context.getBean(WorkbenchProperties.class);
      assertThat(properties.cluster()).isFalse();
    });
    runner.withPropertyValues("workbench.command=start", "workbench.middleware.mode=standalone").run(context -> {
      WorkbenchProperties properties = context.getBean(WorkbenchProperties.class);
      assertThat(properties.cluster()).isFalse();
    });
  }

  @Test
  void bindsExternalNotificationsDefaultsAndOverrides() {
    runner.run(context -> {
      WorkbenchProperties.ExternalNotifications external = context.getBean(WorkbenchProperties.class)
          .getNotifications()
          .getExternal();
      assertThat(external.isEnabled()).isFalse();
      assertThat(external.getChannel()).isEqualTo("noop");
      assertThat(external.getDispatchIntervalMs()).isEqualTo(2000L);
      assertThat(external.getDefaultMergeWindowSec()).isEqualTo(60);
      assertThat(external.getMaxAttempts()).isEqualTo(3);
    });
    runner.withPropertyValues(
        "workbench.notifications.external.enabled=true",
        "workbench.notifications.external.channel=corp-im",
        "workbench.notifications.external.dispatch-interval-ms=5000",
        "workbench.notifications.external.default-merge-window-sec=120",
        "workbench.notifications.external.max-attempts=5"
    ).run(context -> {
      WorkbenchProperties.ExternalNotifications external = context.getBean(WorkbenchProperties.class)
          .getNotifications()
          .getExternal();
      assertThat(external.isEnabled()).isTrue();
      assertThat(external.getChannel()).isEqualTo("corp-im");
      assertThat(external.getDispatchIntervalMs()).isEqualTo(5000L);
      assertThat(external.getDefaultMergeWindowSec()).isEqualTo(120);
      assertThat(external.getMaxAttempts()).isEqualTo(5);
    });
  }

  @Configuration
  @EnableConfigurationProperties(WorkbenchProperties.class)
  static class Enable {}
}
