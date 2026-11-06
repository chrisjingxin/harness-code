# 独立桌面协作工作台

本分支以 Electron + React/TypeScript 建立独立桌面产品。目前提供基础窗口、原生目录选择、主题和窗口缩放。共享会话、云端、Agent 执行、文件/Git 与 Trace 尚未接入；没有预置聊天数据。Runner 当前只有工程骨架。

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

## 工程检查

```sh
npm run typecheck
npm run check:boundaries -- --self-check
npm run project:check
```

七个 workspace 按契约、核心骨架、UI、应用排序，只有一个根 package-lock；普通安装使用 npm ci。必要工程管理小套为 `npm run test:project`，完整回归在总体开发后统一执行。

新入口位于 apps/desktop，UI 与契约位于 packages/workbench-ui 和 workbench-contracts，执行器/ACP/项目服务独立成包。旧 CLI、Web、Python 内核和 vendor 源码暂留供后续迁移，均退出新默认安装和运行路径；旧用户指南中的命令不代表本分支当前能力。Harness 将作为可替换 ACP Agent 接入，可选集成不成为平台启动条件。

设计与进度见 [HC-193](docs/developer/task/HC-193-独立桌面工程与分包.md)、[总体设计](docs/developer/architecture/多人协作工作台顶层设计.md)和[开发工作流](docs/developer/project/开发工作流.md)。
