# Harness Code 快速开始

Harness Code 是面向企业研发场景的 Coding Agent CLI：终端交互由 Bun/OpenTUI 提供，Python Agent sidecar 通过 stdio JSON-RPC 与 CLI 通信，模型接口使用 OpenAI-compatible Chat Completions。当前仓库处于源码开发态；此页说明如何配置、运行一个只读首次任务，以及验证开发环境。

> **安装边界：** 当前没有交付面向用户的通用安装器、自动更新或跨平台预编译发布包。以下命令都是在源码仓库根目录执行的开发命令，不代表 `harness`/`za38` 已作为全局产品安装。

## 从这里开始

- [模型、配置与运行时](configuration.md)：TOML 配置来源、Profile、环境变量和运行时设置。
- [终端任务与会话](workflows.md)：TUI、工作模式、命令、Thread 和任务恢复。
- [终端交互专题](terminal-interaction.md)：时间线条目与截断、检查器侧栏、全部 Slash 命令速查、`/goal` 闭环、文件工具 Snapshot/CAS 与 AGENTS/Skill 快照。
- [审批与执行安全](terminal-and-safety.md)：审批、Policy、文件修改和执行环境边界。
- [Skill、Plugin、子代理与 MCP](extensions.md)：扩展和委派能力。
- [Web 工作台](web-ui.md)：本机 `/web` 接管、重连/归还与浏览器端全部操作。
- [本地日志与离线诊断](diagnostics.md)：日志目录、保留策略、级别配置与 `harness logs` 查询。
- [支持入口与故障分流](web-and-support.md)：按症状找专题的入口页与求助材料要求。
- [故障排查](troubleshooting.md)：按症状恢复，覆盖原指南全部 20 个排障主题与稳定错误码。
- [覆盖索引与已知差异](coverage-index.md)：各用户指南主题的覆盖位置与已知状态。

## 1. 准备开发工具

在仓库根目录操作。依赖同步脚本会在联网安装前检查 Node/npm/uv/Python 版本、锁文件和目标平台；Bun 版本要求适用于下文列出的 CLI 运行、构建和测试命令：

- Node.js `>=20`、npm `>=10`（仓库声明的 npm 版本为 `11.11.0`）；
- Python `>=3.11,<4.0`、uv `>=0.11.1`；
- Bun `1.3.13`，用于 CLI/TUI 运行、构建和 CLI TypeScript 测试；
- 有权限访问的企业 OpenAI-compatible 网关及对应模型、密钥。

npm 是根目录的 workspace 编排入口；这不等于 CLI 已改用 Node 运行。`npm run dev` 会调用 `packages/cli` 的 `bun src/index.ts`。依赖同步由 Node 脚本、npm 和 uv 完成，不要求 Bun 代替 npm/uv；但需要以上工具均已安装。

## 2. 安装并同步锁定依赖

```sh
npm run deps:sync
```

从仓库根目录执行。该脚本默认按现有 `package-lock.json` 和 `packages/agent/uv.lock` 冻结同步，安装 JS 与 Python 依赖、校验本机 OpenTUI native package、应用项目所需的 DeepAgents 补丁并运行依赖检查。不要用单独的 `uv sync` 取代它。

只有确实更改依赖声明或包源、需要重新生成锁文件时才使用：

```sh
npm run deps:sync -- --update-lock
```

这会更新 npm 与 uv 锁文件并继续同步。普通首次设置或日常验证不要用 `--update-lock`。内网环境应使用组织配置的 npm/Python 包源，并确保锁文件中的制品来源与本次安装源相符；脚本识别 `HARNESS_NPM_REGISTRY`、`HARNESS_PYPI_INDEX` 等源设置，但当 npm、pip 或 uv 已有配置时应先核实实际选用源，避免混用或与锁文件不匹配。示例不写企业内部地址。

Linux musl 用户须在依赖同步和运行 TUI 前设置 `OPENTUI_LIBC=musl`；省略时平台门禁按 glibc 处理。该变量仅允许空值、`glibc` 或 `musl`。在 Bash/Zsh 中执行：

```sh
export OPENTUI_LIBC=musl
npm run deps:sync
```

在 PowerShell 中执行：

```powershell
$env:OPENTUI_LIBC = "musl"
npm run deps:sync
```

## 3. 创建最小用户配置并设置密钥

Harness 从用户目录读取 `~/.harness/config.toml`。在 POSIX shell 中创建目录：

```sh
mkdir -p "$HOME/.harness"
```

在 PowerShell 中创建目录：

```powershell
New-Item -ItemType Directory -Force "$HOME\.harness" | Out-Null
```

将下面的**完整最小 TOML** 保存为 `~/.harness/config.toml`（Windows 对应 `$HOME\.harness\config.toml`）。把模型名和示例 `.invalid` 地址替换为组织提供的值；`base_url` 必须是网关接受 OpenAI-compatible Chat Completions 请求的基础 URL。`api_key_env` 是环境变量名，不是密钥：

```toml
[config]
version = 1

[models]
default_profile = "default"

[models.profiles.default]
provider = "openai-compatible"
model = "替换为网关模型标识"
base_url = "https://gateway.example.invalid/v1"
api_key_env = "HARNESS_API_KEY"
context_window_tokens = 128000
capabilities = ["tool-calling", "streaming"]
```

POSIX 用户可收紧配置文件权限：

```sh
chmod 600 "$HOME/.harness/config.toml"
```

如在用户级 TOML 中使用明文 `api_key` 降级值，加载器会在支持 POSIX 权限的平台尝试自动收紧文件权限；优先使用环境变量，不要将密钥放进显式配置、仓库或聊天记录。Windows 用户应通过受信任的凭据管理方式保护本地配置及其密钥。

在启动 Harness 的同一终端会话中提供 `HARNESS_API_KEY`。Bash/Zsh 交互终端可用以下方式隐藏输入：

```sh
printf "Gateway API key: "
IFS= read -r -s HARNESS_API_KEY
printf '\n'
export HARNESS_API_KEY
```

PowerShell 示例：

```powershell
$secret = Read-Host "Gateway API key" -AsSecureString
$env:HARNESS_API_KEY = [System.Net.NetworkCredential]::new("", $secret).Password
```

这两种方式都只为当前终端进程设置环境变量；如由企业秘密管理器注入，使用组织认可的注入方式即可，不要把实际值填进文档或命令历史。配置检查可使用源码 CLI 的 `npm run dev -- config path` 和 `npm run dev -- config show`；`config show` 显示脱敏后的有效值及密钥来源，不应输出密钥值。

除密钥变量外，源码还支持用 `HARNESS_MODEL`、`HARNESS_BASE_URL`、`HARNESS_API_KEY_ENV`、`HARNESS_TIMEOUT_SECONDS` 和 `HARNESS_MAX_RETRIES` 覆盖默认模型 Profile 的对应值；`HARNESS_APPROVAL_MODE`、`HARNESS_SANDBOX`、`HARNESS_LOG_LEVEL`、`HARNESS_GOAL_GRADER_MODEL`、`HARNESS_GOAL_MAX_ITERATIONS` 分别是运行时策略、诊断级别或 Goal 覆盖。它们是可选覆盖，不是最小配置的必填变量；详细规则见[模型、配置与运行时](configuration.md)。依赖源变量见[依赖同步](#2-安装并同步锁定依赖)，Linux 原生包变量见[平台边界](#6-平台与能力边界)。

配置加载的安全边界：当前只加载用户级 `~/.harness/config.toml` 和显式指定的 `--config PATH`。工作区内 `.harness/config.toml` 或 `.harness/config.local.toml` 若未通过 `--config` 明确指定，会在模型初始化前导致拒绝，不会自动信任或合并项目配置。提供 `--cwd` 时必须指向已存在的工作区目录；CLI 不会替你创建它。

## 4. 启动真实终端，完成只读首次任务

在仓库根目录、真实终端中启动：

```sh
npm run dev
```

CLI 启动后应进入交互式 TUI。提交一个明确限制范围的首次任务，例如：

> 只阅读当前工作区已有文件，概述项目结构并指出主要入口文件；不要写入、删除或修改任何文件，不要运行 Shell 命令或访问网络。

这样可以先检查配置、模型网关和只读文件浏览链路，而不把首次运行变成写入任务。观察 TUI 中的回答和工具事件；如遇需要审批的动作，拒绝或取消并保持任务只读。`Ctrl+C` 在运行时取消当前任务；`Esc` 不是运行取消键。

交互 TUI 要求 stdin、stdout 都连接到真实 TTY。若在 IDE 任务捕获器或管道里看到终端控制序列，回到本机真实终端从仓库根目录直接运行；不要将 TUI 输出重定向到普通日志文件后当作正常交互。

## 5. 开发验证与无头运行

依赖已同步后，可先运行不进入 Bun CLI 边界的工程检查：

```sh
npm run deps:test
npm run test:project
npm run project:check
npm run typecheck
```

它们分别检查依赖/源码策略、项目管理工具、协议与项目一致性、CLI TypeScript 类型。需要 Bun `1.3.13` 的命令包括：

```sh
npm run dev
npm run build
npm run test:ts
npm test
```

完整 `npm test` 除项目、依赖和 TypeScript 测试外也运行 Python 测试。运行特定检查前确认该命令依赖的本地 JS/Python 依赖已经同步；单机命令成功并不能代替每个目标平台的安装和 TUI 验收。

无头执行只适用于不需要人工审批、问答、目录信任、计划或 Goal 确认的任务：

```sh
npm run dev -- --non-interactive --message "只读列出当前项目的主要入口文件，不要修改文件或联网。" --json
```

`--non-interactive`（短选项 `-n`，也可写作 `-n <消息>`）必须附带一条消息；`--json` 让结果以 JSON 输出。`--config PATH` 通过 `HARNESS_AGENT_CONFIG_PATH` 传给 Python sidecar；`--sandbox` 只接受 `remote`（或 `true`）与 `false`/`off`，其他值会报错。无头客户端没有交互式审批、提问、目录信任、计划和 Goal 的处理器，因此需要这些人工裁决的任务不要用无头模式，也不要假设缺少处理器等于获得许可。无头模式不能与 `--resume` 同用；`--resume` 只能用于交互 TUI、不接受 Thread ID；旧 `--continue`/`-c` 已废弃并被拒绝。要恢复 Thread，请进入交互 TUI。

## 6. 平台与能力边界

- OpenTUI `0.4.3` 的依赖同步门禁接受 macOS x64/arm64、Windows x64/arm64、Linux x64/arm64；Linux 原生包区分 glibc 与 musl。当前 `third_party/npm/` 源码化了若干关键 npm workspace 包，其他目标的原生 optional package 仍需要当前配置的包源提供。
- 上述平台矩阵是依赖脚本验证的目标，不代表本机以外的安装、冷缓存依赖解析、终端兼容性或 TUI 已通过最终用户验收。缺少 native package 时先检查 npm 源和目标平台/架构，再按正常流程重新同步；不要复制其他机器的 `node_modules`。
- 本机没有 Bun 时，前述 npm 工程检查仍是不同的验证路径，但 `npm run dev`、构建及 Bun 测试不能运行。npm 统一入口不意味着移除了 Bun 运行时依赖。
- 远端 sandbox 需要组织提供并验证的执行 Provider；命令行接受远端请求本身不等于仓库提供了可用的远端基础设施。普通本机执行也不能描述为已经隔离在 Docker/Podman 沙箱中。
- 当前没有面向用户的跨平台安装器或预编译发布物；从源码运行是本指南覆盖的方式，不要把源码开发命令当作生产安装指引。

## Backlog

- **安装器与发布包**（`README.md` 的开发态说明）：仓库未交付通用安装器、自动更新或跨平台预编译发行物，因此本页只给源码工作流。
- **完整跨平台验收**（`scripts/dependencies/vendor_policy.mjs` 的 native package 支持矩阵）：源码列出支持的目标，但单个平台的安装成功不证明所有 OS/架构/终端都已最终验收。
- **企业远端执行环境**（`packages/cli/src/args.ts` 的 `--sandbox` 解析与 `packages/agent/harness_agent/config/config.py` 的 remote 配置）：CLI 可表达远端请求，但实际 Provider、认证和基础设施需由组织提供。

## 维护线索

本页命令以当前 `package.json`、`packages/cli/package.json`、`packages/cli/src/args.ts`、`packages/cli/src/index.ts`、`packages/agent/pyproject.toml`、`packages/agent/harness_agent/config/config.py` 与 `scripts/dependencies/` 实现为准。近期提交 `ae69df6` 将根目录工程编排迁至 npm，但保留 CLI Bun 运行边界；后续更新时应同时检查根脚本与 CLI workspace 脚本，避免把 npm 入口误写成 Node 运行时。
