# 独立桌面协作工作台

本分支以 Electron + React/TypeScript 建立独立桌面产品，保留已实现的三栏、主题、对话和文件组件。2026-11-12 远端 Java 服务已改为 Project 成员制、HTTPS 上传定稿消息/工具摘要、简报与按需历史读取；旧远端执行、WSS、正文 SSE 及实时文件/Git 路由已移除。桌面和 Runner 的旧业务装配仍需适配，不能把既有界面冒烟当作新版端到端已通。轻量 SSE、Task、知识和看板由 HC-212 承接；后端与 ACP 以当前远端为准。见[顶层设计](docs/developer/architecture/多人协作工作台顶层设计.md)及[任务衔接](docs/developer/project/项目协作设计任务衔接.md)。

前端已登记四张待认领任务：HC-217 项目导航、HC-218 会话只读与主动同步、HC-219 引用/任务/知识、HC-220 看板与轻量通知。职责、依赖和并行接点见[前端任务分工](docs/developer/project/项目协作设计任务衔接.md#3-前端任务与并行顺序)，外观对照见[协作工作台交互原型](docs/developer/previews/collaboration-workbench/README.md)（原 [personal-team-workbench](docs/developer/previews/personal-team-workbench/README.md) 已标记过期）。当前仅完成设计与建卡，生产实现按各卡 Spec → Plan → Todo 推进，服务端和 ACP 由同事负责。

## 从源码启动

准备 Node.js `>=22.12.0`、npm（仓库声明 `11.11.0`）及可下载目标平台 Electron 的网络或镜像。在仓库根目录执行：

```sh
npm ci
npm run dev
```

不需要安装 Bun、uv、Python、Harness，也不需要模型密钥。Electron 首次使用会从官方源下载二进制，网络受限时需使用可用缓存或配置镜像，不能把仅 npm 包安装成功当成窗口已启动。

运行已构建页面：

```sh
npm run build
npm --workspace @workbench/desktop run preview
```

窗口操作与当前能力见[独立桌面工作台](docs/user/独立桌面工作台.md)、[快速开始](docs/user/快速开始.md)和[安全与沙箱](docs/user/安全与沙箱.md)。Windows/macOS 完整交付与签名验收留后续阶段，当前不承诺正式安装包。

## 显式启动 Java 数据基础

只有下列服务命令需要完整 JDK 21、Maven 和已准备的 MySQL 兼容数据库；桌面构建不会自动安装这些工具或启动数据库。通过 `JAVA_HOME` 指定 JDK，必要时用 `MAVEN_EXECUTABLE` 指定 Maven。首次准备数据库需由 DBA 或开发者显式执行[唯一 schema.sql](server/src/main/resources/db/schema.sql)，之后再初始化演示数据和启动；应用只核对结构，不建表。

```sh
npm run server:build
npm run contracts:smoke
npm run server:contracts
npm run server:init-demo
npm run server:start
```

构建与契约检查不连接数据库。初始化/启动前通过受限配置提供 `SPRING_DATASOURCE_URL/USERNAME/PASSWORD` 及 TLS 信任，不在源码或命令参数写真实密码。当前已移除 Flyway、V001～V003 和 server:migrate，不使用旧建库步骤。示例服务地址为 `http://127.0.0.1:18084`，业务响应采用当前 BeeResponseEntity 包络；组织和同步接口见 [HC-211 Spec](docs/developer/spec/HC-211-协作模型重构与只读同步.md)，会话快照、任务、知识、看板与通知接口和联调示例见 [HC-212 Spec](docs/developer/spec/HC-212-协作应用与看板通知.md)。standalone 开发模式不代表 Redis/Kafka/ES 集群已验证，部署配置以[Java 中继方案](docs/developer/project/Java中继调整方案.md)及当前 application.yml 为准。

桌面只从宿主启动环境变量 `WORKBENCH_SERVICE_ORIGIN` 读取一个固定服务origin。研发先显式启动前述Java/MySQL，再运行：

```sh
WORKBENCH_SERVICE_ORIGIN=http://127.0.0.1:18084 npm run dev
```

远程服务使用 HTTPS，本机允许上述 loopback HTTP。桌面可按源码入口打开；现有 shared-conversation/设备 UI 尚有旧接口调用，不能按旧指南期待其已适配新版后端。后续装配将提供 Project 导航、简报/Task 轻量通知和主动正文同步；所有跨机器只读，包括同账号其他设备，继续工作需基于快照新建本机会话。目录可以不是 Git，文件阅读组件用于本机；Git 写入口暂缓。

远端 D10 已取消跨机器实时文件/Git 访问。HC-199 原设备读取的[历史证据](docs/developer/task/HC-199-文件与Git服务迁移.md#原设备只读路由实施证据2026-11-11复核通过)保留，但不代表当前服务还开放该路由；查看者只读云端已上传内容。

当前 schema.sql 声明 20 张服务端表（含会话快照、项目任务、知识版本、通知发件箱与团队管理回执），组织模型和只读同步停点见 [HC-211 Todo](docs/developer/todo/HC-211-协作模型重构与只读同步.md)，实库全链路冒烟仍待补齐。HC-195/196/198 已由远端标过时，原阶段证据继续保留。Windows、TDSQL、真实中间件与新版桌面整体验证另行完成。

## 工程检查

```sh
npm run typecheck
npm run check:boundaries -- --self-check
npm run project:check
```

四个 workspace（`desktop`、`packages/collaboration-client`、`packages/acp-runtime`、`packages/harness-acp`）共用唯一根 `package-lock.json`；普通安装使用 `npm ci`。必要工程管理小套为 `npm run test:project`，完整回归在总体开发后统一执行。

架构采用五层多语言目录：`contracts/` 存放语言无关的线上 OpenAPI 与 Schema 契约；桌面壳与工作台 UI/本地文件服务位于 `desktop/`（含 `src/ui`、`src/shared`、`src/main/project-service`），跨平台协作客户端位于 `packages/collaboration-client`，通用 ACP 运行时位于 `packages/acp-runtime`，可选 Harness ACP 适配器与 Python 内核位于 `packages/harness-acp` 和顶层 `agent/`，Java 协作服务端位于 `server/`。旧 CLI、TUI、独立 Web、旧 `@za38/protocol`、旧 `apps/runner` / `packages/runner-core`、`packages/providers/{pi,qwen}` 及 OpenTUI/Bun vendor 源码已退役；`agent/` 作为可选 Harness Python ACP Agent 独立保留，不进入默认安装和运行路径，平台可在无 Harness/Python 时使用其他 ACP Agent。

设计与进度见 [HC-193](docs/developer/task/HC-193-独立桌面工程与分包.md)、[总体设计](docs/developer/architecture/多人协作工作台顶层设计.md)和[开发工作流](docs/developer/project/开发工作流.md)。
