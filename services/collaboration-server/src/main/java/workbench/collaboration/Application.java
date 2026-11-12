package workbench.collaboration;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import workbench.collaboration.infrastructure.contract.Contracts;

import java.util.Arrays;
import java.util.Set;

/**
 * 模块：协作服务总启动入口 (Application)
 *
 * <p>【功能定义】
 * 本模块为独立桌面协作工作台 Java 中继服务（collaboration-server）的标准 Spring Boot 主启动入口。
 * 负责引导 Spring 容器装配、解析启动引导参数，并按需执行契约自检、数据库迁移或常驻 Web 协作中继服务。
 *
 * <p>【协作边界】
 * - 上游调用方：操作系统进程管理、Docker 容器、Node 运维脚本（scripts/workbench/server.mjs）。
 * - 下游依赖方：MyBatis-Plus Mapper 扫描层、配置属性绑定层、Contracts 契约冒烟校验引擎。
 *
 * <p>【启动模式流转时序】
 * <pre>
 * CLI 命令行入参 args ──> 提取 --workbench.command
 *                              │
 *     ┌────────────────────────┼────────────────────────┐
 *     ▼                        ▼                        ▼
 * [contracts]             [migrate / init-demo]      [start] (默认)
 * 纯内存契约自检            无 Web 容器 (NONE)          Servlet 容器 (SERVLET)
 * 不连数据库/中间件         执行数据库操作后关闭退出    常驻监听 HTTP/WebSocket/SSE
 * </pre>
 */
@SpringBootApplication
@MapperScan("workbench.collaboration.infrastructure.persistence.mapper")
@ConfigurationPropertiesScan("workbench.collaboration.infrastructure.config")
public class Application {

    /**
     * 服务主函数。
     *
     * <p>【契约说明】
     * - 入参：args 命令行入参，支持通过 "--workbench.command={command}" 指定运行模式。
     *   - "start"（默认）：启动 HTTP/SSE/WebSocket 协作服务；
     *   - "contracts"：执行平台与中继服务双端 JSON Schema 契约自检，零外部网络与数据库依赖；
     *   - "migrate"：仅执行 Flyway/DDL 数据库迁移，完成即退出；
     *   - "init-demo"：仅执行测试演示数据初始化，完成即退出。
     * - 异常：若传入非法命令字，抛出 IllegalArgumentException。
     *
     * @param args 命令行入参
     */
    public static void main(String[] args) {
        // 提取引导命令；若未指定则默认进入常驻服务 "start" 模式
        String command = Arrays.stream(args)
                .filter(arg -> arg.startsWith("--workbench.command="))
                .map(arg -> arg.substring("--workbench.command=".length()))
                .findFirst()
                .orElse("start");

        // 契约独立自检模式：直接在纯内存中核对跨端 Schema 校验，绝不触碰任何数据库或外部中间件
        if (command.equals("contracts")) {
            new Contracts().smoke();
            return;
        }

        // 命令合法性防篡改防御
        if (!Set.of("migrate", "init-demo", "start").contains(command)) {
            throw new IllegalArgumentException("未知运行命令");
        }

        SpringApplication app = new SpringApplication(Application.class);

        // 架构不变量：进程是否监听外部端口必须在 Spring 容器初始化前定死；
        // 迁移与演示数据初始化任务设置为 NONE，防止不必要的端口占用与外部网络请求进入半初始化容器
        app.setWebApplicationType(command.equals("start") ? WebApplicationType.SERVLET : WebApplicationType.NONE);

        var context = app.run(args);

        // 一次性运维命令执行完成后，立即优雅关闭容器释放数据库与文件连接，避免进程挂起
        if (!command.equals("start")) {
            System.out.println("命令完成: " + command);
            context.close();
        }
    }
}
