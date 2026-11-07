package workbench.collaboration;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import java.util.*;
import workbench.collaboration.transport.WebConfiguration;

/** 显式命令入口：契约检查无数据库前置；迁移/初始化一次退出，start 才开放 HTTP。 */
public final class Application {
  private Application() {}
  public static void main(String[] args) {
    String command = Arrays.stream(args).filter(a -> a.startsWith("--workbench.command=")).map(a -> a.substring("--workbench.command=".length())).findFirst().orElseThrow(() -> new IllegalArgumentException("必须提供显式命令"));
    if (command.equals("contracts")) { new Contracts().smoke(); return; }
    if (!Set.of("build", "migrate", "init-demo", "start").contains(command) || command.equals("build")) throw new IllegalArgumentException("未知运行命令");
    SpringApplication app = new SpringApplication(ServerConfiguration.class);
    app.setWebApplicationType(command.equals("start") ? WebApplicationType.SERVLET : WebApplicationType.NONE);
    if (command.equals("start")) app.addPrimarySources(List.of(WebConfiguration.class));
    var context = app.run(args);
    if (!command.equals("start")) { System.out.println("命令完成: " + command); context.close(); }
  }
}
