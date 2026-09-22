# Harness Code（za38-cli）

Harness Code 是面向企业研发场景的 Coding Agent CLI。终端交互由 Bun/OpenTUI 提供，Agent 内核基于 Python、deepagents、LangChain 和 LangGraph，并通过 stdio JSON-RPC 通信。

> 当前处于开发态：请从源码运行。跨平台安装包以及 `curl`、PowerShell、CMD 安装器尚未交付，不能将其视为可用的生产安装方式。

## 开始使用

本地开发固定使用 Bun `1.3.13`（仅 `packages/cli` 的 OpenTUI/FFI 运行、bundler 与 CLI 测试边界）、Python 3.11+ 和 `uv`。根 `package.json` 只使用 npm 做 workspace 编排；依赖安装链路和普通工程工具不会启动 Bun，`npm run dev`、`npm run build` 与 CLI 测试则会转入 `packages/cli` 的上述必要 Bun 边界。依赖安装使用 npm/pip 当前配置：企业外就是公网源，企业内就是企业源。随后通过统一入口安装锁定依赖、应用 DeepAgents 补丁并执行零 Anthropic 门禁：

```bash
mkdir -p ~/.harness
npm run deps:sync
cp docs/user/examples/config.toml ~/.harness/config.toml
export HARNESS_API_KEY='你的企业网关密钥'
npm run dev
```

企业外不需要额外配置源。npm 和 pip 都没写地址时，安装使用 `https://registry.npmjs.org/` 和 `https://pypi.org/simple`。企业内把 npm/pip 配到企业源即可；如果工具配置仍指向公网，可以用 `HARNESS_NPM_REGISTRY`、`HARNESS_PYPI_INDEX` 把这一次安装切到内网。

日常只需执行 `npm run deps:sync`，它会按现有锁文件完成 JavaScript 和 Python 依赖的冻结同步、补丁与验证。只有依赖声明或包源发生变化时，才执行 `npm run deps:sync -- --update-lock`；该模式会更新两个锁文件并继续完成同一套同步与验证，不需要再补跑第二条命令。锁文件里的下载地址必须属于这次选中的源：公网安装接受当前公网锁，内网安装仍会拒绝公网下载地址。工具链版本不符时，同步会在联网前失败。

临时分支 `feat_hc_179_内网依赖源码化` 将五个关键 npm 发布包（含 Windows x64 native 包）放在 `third_party/npm/` 并按 workspace 链接；其余平台 native optional package 由当前 npm 企业源提供。`deps:sync` 支持 OpenTUI `0.4.3` 已发布的 macOS、Windows、Linux x64/arm64 目标，安装后会同时校验五个 workspace realpath 和本机 native 包。该例外不代表 canonical `master` 的永久发布策略，正式内网包可用并完成各目标环境验收后应移除。

在 macOS、Windows 或 Linux 上都可从根目录使用 npm 入口运行工程检查：

```bash
npm run deps:test
npm run test:project
npm run project:check
npm run typecheck
```

以上四条不启动 Bun。`npm run build`、`npm run test:ts` 和完整 `npm test` 会进入 CLI 的 Bun 边界，因此需要 Bun `1.3.13`；npm 是统一入口，但 OpenTUI CLI 尚未脱离 Bun 运行时。

推荐通过 `api_key_env` 引用环境变量。若本机开发环境无法预先设置环境变量，可在权限为 `0600` 的 `~/.harness/config.toml` 模型 Profile 中设置 `api_key` 作为降级值；环境变量非空时始终优先。

可使用 `npm run dev -- --help` 查看当前 CLI 参数；无头运行示例：

```bash
npm run dev -- --non-interactive --message "解释当前目录的项目结构"
```

详细说明：

- [快速开始](docs/user/快速开始.md)
- [模型配置](docs/user/模型配置.md)
- [交互使用](docs/user/交互使用.md)
- [插件管理](docs/user/插件管理.md)
- [完整 Plugin Demo](examples/plugins/harness-full-demo/README.md)
- [安全与沙箱](docs/user/安全与沙箱.md)
- [故障排查](docs/user/故障排查.md)

终端界面使用企业源的 `@opentui/core` / `@opentui/react` `0.4.3`、React `19.2.6` 和 `react-reconciler` `0.33.0`。企业引入 OpenTUI Core 时须同时镜像其目标平台 native optional packages；项目不再携带本地 Core 源码或自行构建的 FFI artifact。

参与开发请从 [开发工作流](docs/developer/project/开发工作流.md) 开始；任务以 [任务看板](docs/developer/task/任务看板.md) 和任务源文件为准。
