---
id: HC-181
title: CLI安装与分发
feature_area: CLI 安装与分发
parent_task: -
decomposed_by: Grok
priority: P0
status: 已完成
owner: Grok
branch: feat_hc_181_CLI安装与分发
scope: 让 macOS、Linux、Windows 用户用一条安装命令装好 Harness，缺 Bun/Python/uv 时由脚本检测并补齐，装完在任意目录输入 harness 进入现有交互主界面；安装走企业包源上的 bun 全局包与 uv 工具包，不打自包含运行时大包，不把 Windows 留到后期。
acceptance: 三系统均可用对应一条命令完成安装；缺依赖时脚本能检测并安装，已有合格依赖则不重复装；装完 PATH 上有 harness，在仓库外目录启动进入 TUI 或按现有规则提示缺终端/缺配置；不支持的系统或架构安装失败并说明原因；不写入 API Key；用户文档给出安装、手动包管理器安装、卸载与常见失败处理。
user_docs: README.md、docs/user/快速开始.md、docs/user/故障排查.md
developer_docs: docs/developer/spec/HC-181-CLI安装与分发.md、docs/developer/plan/HC-181-CLI安装与分发.md、docs/developer/todo/HC-181-CLI安装与分发.md、docs/developer/research/181-CLI安装与分发方案.md、docs/developer/architecture/架构总览.md
test_evidence: CLI focused 59 pass (args/index/runtime-binding/pack/install-sh/install-ps1); agent test_harness_agent_entry 3 passed; bun run typecheck pass; bun run docs:check pass; bun run project:check pass. Review skipped per user. No VERSION bump (0.1.0). Windows live install not run (no pwsh/Windows runner).
references: docs/developer/research/181-CLI安装与分发方案.md、docs/developer/research/168-dcode功能差距.md、docs/developer/project/新功能候选.md
completed_at: 2026-09-15
---

# HC-181 CLI 安装与分发

## 需求来源与当前阶段

2026-09-14，用户要求改变「只能在仓库里 `bun run dev`」的现状，使最终用户能像使用 Grok / Codex / Devin 一样安装后输入 `harness` 进入交互主界面。调研见 [181-CLI安装与分发方案.md](../../research/181-CLI安装与分发方案.md)。

需求确认按 `grill-me` 转用的既有对话整理，不重复访谈。已确认决策见下文。当前阶段是 **已完成**：停点 A–D 已落地。用户要求跳过 code review 并直接归档。未改 JSON-RPC / TUI 交互。无版本号变更（仍为 `0.1.0`）。企业域名与 npm/PyPI 默认地址由托管前填写脚本顶部 `DEFAULT_*`，仓库不写死示例域名。Windows x64 真机安装待包发布后补证据；本环境以脚本契约测试覆盖。

## 通俗说明

现在只有开发者能用 Harness：先克隆仓库，再准备 Bun、Python、uv，最后在仓库根目录执行 `bun run dev`。换一台电脑或换一个文件夹，没有这条开发命令就进不了界面。

本功能让普通用户抄一条安装命令。脚本先检查跑界面和内核要用的工具，没有就帮用户装上，再从企业包源安装 Harness 自己。装完后，进入任意项目目录输入 `harness`，看到的就是现在的交互主界面。

```text
用户执行安装命令
  → 脚本识别操作系统
  → 检查 Bun、Python 3.11+、uv；缺了就安装
  → 从企业源安装界面包和内核包
  → 把 harness 放进 PATH
  → 用户进入项目目录输入 harness，进入现有 TUI
```

Harness 仍是两块一起工作：终端界面由 Bun 运行，背后的 Agent 内核由 Python 运行。安装器负责把这两块都装好并让它们互相找到，不改对话、审批或协议。

## 当前问题

1. README 与快速开始写明只能从源码运行，安装器尚未交付。
2. CLI 只按仓库相对路径寻找 `packages/agent/.venv`，离开源码树会误用系统 Python。
3. 入口必须由 Bun 执行，OpenTUI 依赖 Bun FFI；Node 的 `npm install -g` 跑不起 TUI。
4. 非仓库用户没有一条能在 macOS、Linux、Windows 上同样完成的安装路径。

## 用户最终得到什么

1. macOS / Linux 可用 `curl -fsSL <企业安装入口>/install.sh | bash` 安装。
2. Windows 可用 PowerShell `irm <企业安装入口>/install.ps1 | iex` 安装；文档写明不要在 CMD 或 Git Bash 里跑这条 PowerShell 命令。
3. 安装过程检测 Bun、Python 3.11+、uv；缺失或版本不够则安装到可用，已合格则跳过。
4. 装完在任意已存在的项目目录输入 `harness` 进入现有交互主界面；无头模式仍可用 `harness` 加现有参数，不再需要 `bun run dev`。
5. 没有配置文件时可放入示例配置并提示设置密钥；安装器绝不写入 API Key。
6. 用户文档说明安装、可选的手动包管理器安装、卸载，以及依赖安装失败、PATH 未生效、不支持的系统等处理办法。

## 已确认决策

1. **三个系统同一期交付。** macOS、Linux、Windows 都是本 Task 的验收范围，不把 Windows 留到后续任务。
2. **给用户的是一条安装命令，实现上走包管理器。** 脚本内部安装 `bun` 全局 CLI 包和 `uv tool` 内核包。不打自包含 tarball，不捆绑私有 Bun/CPython 目录作为主路径。
3. **缺依赖就帮用户装。** 必要工具是 Bun（固定项目当前主版本）、Python 3.11+、uv。已有合格版本不重复安装。
4. **不要用 Node 的 `npm install -g` 作为主安装方式。** CLI 必须由 Bun 运行。文档可以额外写手动命令 `bun install -g …` 与 `uv tool install …`，供已有环境的用户使用。
5. **命令名对外是 `harness`。** `za38` 若作为同一可执行文件的别名，不作为对外宣传名。
6. **工作区仍是用户当前目录。** 安装改变的是如何找到界面和内核，不是项目数据放哪里。配置继续使用用户级 `~/.harness/config.toml`（Windows 为用户目录下的 `.harness\config.toml`）。
7. **内网可覆盖下载与包源地址。** 默认入口由 Spec 确定；必须能通过环境变量指向企业镜像，不能写死只能访问公网官方安装器。
8. **开发工作流保留。** 仓库内 `bun run dev` 继续给开发者用，不改成必须先走安装器。

## 范围

- 企业托管的 `install.sh` 与 `install.ps1`，行为一致：检测系统与架构、检测并补齐依赖、安装两个包、配置 PATH、安装后自检。
- 将 `@za38/cli`（及它依赖的 protocol）和 `za38-agent` 发成可安装包；Python 包提供稳定的内核启动方式。
- CLI 在安装形态下定位已安装的 Python 内核，不再只认仓库 `packages/agent`；Windows 按该平台可执行文件名称查找，不能只找 `python3`。
- 安装后 `harness --version` 可用于脚本自检；失败时保留已有安装或明确报错，不留下半安装状态当成功。
- 不支持的 OS/架构在安装开始时拒绝并说明，不允许装完再因缺 native 库崩溃。
- 更新 `README.md`、`docs/user/快速开始.md`、`docs/user/故障排查.md`；实现完成后在架构总览补充安装启动路径。

## 非范围

- 自包含平台 tarball、把 Bun 或 CPython 打进 Harness 安装包。
- 应用内 `/update`、后台自更新、Homebrew cask、Node 官方 npm 全局包作为主路径。
- 安装时浏览器登录、代填或写入 API Key。
- 重写 Agent 为 TypeScript/Rust，或改 JSON-RPC、TUI 交互、模型配置语义。
- 改变源码开发的 `bun run dev` 流程。
- 以 Alpine/musl 或 Windows ARM 为第一验收平台。这两者若依赖没有对应构建，安装器必须拒绝并说明；不能把它们当成「Windows/Linux 已交付」的替代证明。Linux glibc x64/arm64、macOS Intel/Apple Silicon、Windows x64 必须可安装。

## 可观察验收

1. 在未克隆本仓库的 macOS、Linux、Windows x64 机器上，用上文对应的一条命令能完成安装。
2. 机器缺少 Bun、合格 Python 或 uv 时，脚本会安装缺失项后再安装 Harness；三项都已合格时不再重复安装运行时。
3. 安装结束后，新开终端（或脚本已把命令加入当前 PATH）在任意已有目录执行 `harness`，进入现有交互 TUI；非 TTY 时仍按现有规则拒绝交互并提示无头用法。
4. `harness --version` 打印与发布版本一致的版本号；安装脚本在切换 PATH 前用它做成功判定。
5. 离开仓库后，CLI 能启动 Python 内核，而不是去找 `packages/agent/.venv` 或一个没有 `harness_agent` 的系统 Python。
6. 已有 `config.toml` 不被覆盖；没有配置时最多放入示例并提示设置 `HARNESS_API_KEY` 或同等现有配置方式，文件与日志中不出现密钥。
7. 在 CMD 运行 Windows 的 `irm | iex`、在不支持的架构上运行安装脚本，都会得到可理解的失败说明。
8. 用户文档不再把「只能从源码运行」写成现状。

## 文档与后续

- 调研：[181-CLI安装与分发方案.md](../../research/181-CLI安装与分发方案.md)
- Spec / Plan / Todo：[HC-181-CLI安装与分发.md](../../spec/HC-181-CLI安装与分发.md)、[同名 Plan](../../plan/HC-181-CLI安装与分发.md)、[同名 Todo](../../todo/HC-181-CLI安装与分发.md)。
- 候选清单中的「自包含运行包与独立安装器」由本 Task 承接；实现改为包管理器安装加依赖补齐，不再做自包含大包。
