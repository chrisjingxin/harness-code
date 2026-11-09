# 独立桌面协作工作台

本分支以 Electron + React/TypeScript 建立独立桌面产品，提供基础窗口、主题、缩放、演示登录及本机项目登记、共享和执行器托管。Java 协作服务支持共享会话持久保存、排队、历史与 SSE 同步，通过设备通道连接本机 Runner。完整对话界面、真实 ACP Agent、文件/Git 与 Trace 由后续任务接入。服务和数据库需显式配置、启动。

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

基础窗口的操作与当前限制见[独立桌面工作台](docs/user/独立桌面工作台.md)、[快速开始](docs/user/快速开始.md)和[安全与沙箱](docs/user/安全与沙箱.md)。Windows/macOS 完整交付与签名验收留后续阶段，当前不承诺正式安装包。

## 显式启动 Java 数据基础

只有下列命令需要完整 JDK 21、Maven 3.9.11 和已准备的 MySQL 兼容数据库；原桌面安装/构建/启动不会自动安装这些工具或启动数据库。通过 `JAVA_HOME` 指定可用 JDK，必要时用 `MAVEN_EXECUTABLE` 指定 Maven；已有工具均可复用，不依赖某个 IDE 或开发机路径。

```sh
npm run server:build
npm run contracts:smoke
npm run server:contracts
npm run server:migrate
npm run server:init-demo
npm run server:start
```

构建与共同契约检查不连接数据库。迁移/初始化/启动前需通过受限外部配置提供 `SPRING_DATASOURCE_URL/USERNAME/PASSWORD` 和对应 TLS 信任，不在源码或命令参数写入真实密码；迁移与普通运行使用各自所需权限。迁移和演示初始化是显式操作，普通启动不会建表或补回账号/成员。示例服务地址为 `http://127.0.0.1:18084`，`GET /health` 返回就绪状态，`GET /api/v1/meta` 还需匹配的 Origin 和 `X-Workbench-Protocol-Version: 1`；身份HTTP、宿主main客户端和最小桌面身份区域已通过本机真实冒烟；未经认证的受保护接口拒绝访问。研发可显式提供本机隔离环境配置后运行 `node scripts/workbench/run-identity-smoke.mjs`，该入口只复用已初始化实例；准备方式和真实结果见Task/Plan。

桌面只从宿主启动环境变量 `WORKBENCH_SERVICE_ORIGIN` 读取一个固定服务origin。研发先显式启动前述Java/MySQL，再运行：

```sh
WORKBENCH_SERVICE_ORIGIN=http://127.0.0.1:18084 npm run dev
```

HTTPS用于远程服务；仅本机允许上述loopback HTTP。窗口的“演示身份”选择user01～user03后登录，查看真实成员；“退出 / 切换账号”先退出再重新选择。在“本机设备”选择目录并登记，明确共享后可启动本机执行器。关窗保留已启动的执行器，重开需重新登录；“停止”或应用退出会等待执行器收尾。没有服务配置时基础窗口仍可使用，身份区域显示不可用。Cookie/CSRF只留main内存，设备凭据和执行记录保存在原设备的受限SQLite账本中。完整使用边界见用户指南。

工具按各设备的 OS/CPU/系统版本选择。当前数据迁移为V001身份三表、V002设备三表与V003会话执行六表，普通启动只校验已有迁移。准备方法见 [HC-194 Plan](docs/developer/plan/HC-194-协作契约与云端基础.md)，本轮本机冒烟与覆盖范围见 [HC-195 Task](docs/developer/task/HC-195-共享会话与实时同步.md) 和 [HC-196 Task](docs/developer/task/HC-196-设备接入与本机执行.md)。Windows、目标TDSQL和真实ACP的整体验证留HC-204。

## 工程检查

```sh
npm run typecheck
npm run check:boundaries -- --self-check
npm run project:check
```

七个 workspace 按契约、核心骨架、UI、应用排序，只有一个根 package-lock；普通安装使用 npm ci。必要工程管理小套为 `npm run test:project`，完整回归在总体开发后统一执行。

新入口位于 apps/desktop，UI 与契约位于 packages/workbench-ui 和 workbench-contracts，执行器/ACP/项目服务独立成包。旧 CLI、Web、Python 内核和 vendor 源码暂留供后续迁移，均退出新默认安装和运行路径；旧用户指南中的命令不代表本分支当前能力。Harness 将作为可替换 ACP Agent 接入，可选集成不成为平台启动条件。

设计与进度见 [HC-193](docs/developer/task/HC-193-独立桌面工程与分包.md)、[总体设计](docs/developer/architecture/多人协作工作台顶层设计.md)和[开发工作流](docs/developer/project/开发工作流.md)。
