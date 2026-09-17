---
id: HC-182
title: Node与Ink运行时迁移
feature_area: CLI 运行时与终端界面
parent_task: -
decomposed_by: Codex
priority: P0
status: 进行中
owner: Codex
branch: feat_hc_182_Node与Ink运行时迁移
scope: 将 CLI 从 Bun/OpenTUI 迁移为 Node.js >=20、npm 与 Ink 6.8.0 的单一运行路径，同时替换构建、测试、Web server、安装脚本和开发命令中的 Bun 依赖；保留 Python Agent、JSON-RPC v3、共享 Interactive Core 与 Web 交互语义。
acceptance: 同一份 npm 锁文件和构建产物在 Node 20、22、24 上完成安装、启动、一次完整 TUI 对话和 Python sidecar 生命周期；运行、构建、测试与安装不再需要 Bun；Ink 界面采用已确认的主屏滚屏、键盘优先和内联面板交互，并维持当前支持平台范围。
user_docs: README.md、docs/user/快速开始.md、docs/user/交互使用.md、docs/user/故障排查.md
developer_docs: docs/developer/spec/HC-182-Node与Ink运行时迁移.md、docs/developer/plan/HC-182-Node与Ink运行时迁移.md、docs/developer/todo/HC-182-Node与Ink运行时迁移.md、docs/developer/architecture/架构总览.md、docs/developer/architecture/TUI表现层.md
test_evidence: 停点 A：Node 20.20.2 下 typecheck/build/project-check、115 个 CLI tests、17 个 project tests 通过；npm 10.9.3 npm ci 通过
references: docs/developer/task/archive/HC-181-CLI安装与分发.md、docs/developer/task/archive/HC-145-TUI视觉与渲染重构.md、docs/developer/task/archive/HC-103-legacy-提取共享交互内核并迁移TUI.md
completed_at: -
---

# HC-182 Node 与 Ink 运行时迁移

## 需求来源与当前阶段

2026-09-17，用户反馈 Bun 在企业内部环境无法启动，可能受到网络或进程策略限制，因此要求把 Harness Code 从 Bun/OpenTUI 迁移到企业已有的 Ink `6.8.0` 与 npm 原生运行路径。用户进一步确认 Node.js 的兼容范围为 `>=20`，而不是只锁定 Node 20。

需求已按 `grilling` 方法确认：接受主屏滚屏和键盘优先的 Ink 交互；在同一 Task 内完整移除 Bun；Node 由企业环境提供，安装器不默认从公网下载；维持现有 macOS、Linux glibc 与 Windows x64 平台范围。

用户已确认同名 Spec / Plan / Todo 并要求开始开发。Task 已由 Codex 认领，实施分支为 `feat_hc_182_Node与Ink运行时迁移`。用户进一步确认：开发环境可使用当前普通 npm registry 查询和拉取依赖，迁入企业后的 registry 可用性与安装验收由用户完成；因此 P2 不再阻塞本地开发。

## 通俗说明

Harness 当前的终端界面、构建、测试和安装都依赖 Bun。即使只把包管理命令改成 npm，OpenTUI、`Bun.build`、`Bun.serve`、`bun:ffi` 和 `bun:test` 仍然会在企业机器上要求 Bun，因此不能解决实际启动问题。

本功能把 CLI 改成标准 Node.js 程序，并用企业已有的 Ink `6.8.0` 重写终端表现层。对话、模型调用、工具执行、审批、Thread 和 Python Agent 的业务语义保持不变；变化集中在终端如何显示、CLI 如何构建测试，以及用户如何安装和启动。

```text
用户通过企业 npm 安装 Harness CLI
  → Node.js >=20 启动预编译的 JavaScript 入口
  → CLI 启动现有 Python Agent sidecar
  → InteractiveController 继续管理对话与交互状态
  → Ink Renderer 显示历史、流式输出、输入和审批
  → stdio JSON-RPC v3 继续驱动 Agent
```

Ink 不负责模拟现有 OpenTUI 的完整桌面式全屏窗口。已经完成的历史消息交给终端原生滚屏；当前流式内容、输入框、审批和选择器保留在底部动态区域。这样可以避开自造 ScrollBox、Overlay 和鼠标系统，把运行依赖和终端兼容风险降到最低。

## 当前问题

1. 根工作区固定 Bun 包管理器，开发、构建、测试、任务脚本和安装文档均以 `bun run` 为入口。
2. CLI 直接依赖 `@opentui/core` / `@opentui/react` `0.4.3`；该路径依赖 Bun 与平台 native package，企业环境无法稳定启动。
3. CLI 仍使用 `Bun.build`、`Bun.serve`、`bun:ffi`、`Bun.version` 和 `bun:test`，因此不能通过替换 lockfile 或安装命令完成迁移。
4. 当前 TUI 表现类型泄漏 OpenTUI 的 `KeyEvent`、`ScrollBoxRenderable` 和 `TextareaRenderable`，Renderer 尚未形成可直接替换的纯 Ink 边界。
5. OpenTUI 提供的 textarea、scrollbox、overlay 和鼠标交互在 Ink `6.8.0` 中没有一一对应的核心控件，逐像素复刻会形成新的私有 TUI 框架。
6. Node 20 满足 Ink `6.8.0` 的最低要求，但已结束官方维护；项目必须把它作为最低兼容基线，同时验证仍受支持的 Node 22 与 Node 24。
7. 仅改 JavaScript Runtime 不一定能解决全部企业限制：Node 启动 Python 子进程、stdio 双向通信和 Web loopback server 仍需在目标环境验证。

## 用户最终得到什么

1. Harness CLI 可在任意 Node.js `>=20` 环境中运行，不再要求安装或启动 Bun。
2. 企业可以用标准 npm 与内部 registry 安装 CLI，并用同一份 lockfile 和构建产物支持 Node 20、22、24。
3. 终端仍支持完整对话、流式模型输出、工具活动、审批、问答、计划、命令补全、文件选择、取消和 Thread 恢复。
4. 已完成消息保留在终端原生 scrollback；输入与当前运行状态使用 Ink 动态渲染，长对话不持续重绘全部历史。
5. Web 工作台继续复用同一个 Interactive Core；迁移构建和本地 server 后，其交互语义与安全边界不发生变化。
6. Python Agent、deepagents、LangChain、LangGraph、SQLite 和 JSON-RPC v3 不因界面迁移而改写。
7. 缺少 Node.js `>=20` 时，安装器明确提示用户使用企业 Node 安装渠道，不默认访问公网下载运行时。

## 已确认决策

### 1. 唯一 Runtime 为 Node.js `>=20`

- `engines.node` 表达最低版本 `>=20`，不设置主版本上限。
- 构建输出以 Node 20 为语法和 API 基线，类型检查使用 Node 20 类型定义，不能误用只存在于更高版本的 API。
- 同一份产物覆盖 Node 20、22、24，不按 Node 主版本维护实现分支。
- Node 20 是最低兼容版本，不是长期推荐生产版本。企业没有延长安全维护时，生产环境优先使用仍受支持的 Node 22 或 Node 24。

### 2. 固定 Ink `6.8.0` 与 React 19

- 企业已提供 Ink `6.8.0`，本 Task 不追随要求更高 Node 版本的后续 Ink 主版本。
- 复用当前 React `19.2.x`；Ink 和 Web React 必须由同一套 npm 依赖解析，不维护两份 React Runtime。
- 不继续评估或实现 OpenTUI、Pi TUI 等并行 Renderer，也不保留 Bun/OpenTUI fallback。

### 3. 主屏滚屏与键盘优先

- 已完成且不可变的对话记录通过 Ink `Static` 或等价的一次性输出进入终端 scrollback。
- 当前流式消息、推理、工具状态和输入区留在动态渲染区域。
- 取消应用内历史 ScrollBox、鼠标 hover/click 和常驻右侧 Sidebar；终端原生滚动与选择负责历史浏览和复制。
- 审批、Question、Plan、Goal、命令与文件选择器改为底部互斥的内联面板；文件和工具详情使用全宽临时视图。
- 不以视觉逐像素一致为验收目标，但必须保留现有任务完成所需的交互能力、清晰反馈和键盘可达性。

### 4. 保留共享 Interactive Core

- `InteractiveController`、Feature、Selector、共享展示策略和 JSON-RPC Client 继续作为业务事实来源。
- 现有 `TuiAdapter` 的 snapshot / intent seam 应复用；OpenTUI 类型、ref 和滚动状态从它的公开 interface 中移除。
- Ink Presentation 只消费 snapshot 并派发 intent，不能把模型、工具、审批或 Thread 业务逻辑重新写进 React 组件。
- Web Renderer 继续与 TUI 共享同一个 Controller，不能因迁移复制第二套运行状态。

### 5. 最小多行输入栏

- Ink `6.8.0` 没有可直接替换当前 textarea 的完整核心控件，本 Task 实现 Harness 所需的最小 `InputBar`，而不是引入完整编辑器框架。纯编辑逻辑使用 `InputBuffer`；不得使用容易与 Compose 工作模式混淆的 Composer 命名。
- `InputBar` 必须覆盖输入、删除、光标移动、换行、提交、粘贴、Prompt history、Slash 命令和 `@` 文件补全。
- 中文、emoji、组合字符和终端显示宽度必须有明确测试；Enter、换行组合键、Ctrl+C 和取消语义必须在 Spec 中固定。
- 输入 buffer 与光标转换应保持纯逻辑，可脱离终端做确定性测试；Ink hook 只负责键盘事件适配和渲染。

### 6. 一次性移除全部 Bun 路径

- 同一 Task 覆盖 TUI、根工作区、CLI 构建、Web assets、Web server、测试、工程脚本、安装器与文档。
- npm workspaces 和根 `package-lock.json` 成为唯一 JavaScript 依赖路径。
- 生产发布物是预编译 JavaScript，最终用户不需要 TypeScript runner。
- 使用 Node 标准库替换进程、信号、HTTP 和文件能力；WebSocket、bundler 与 test runner 只能选择企业源可用且 Node `>=20` 兼容的版本。
- 完成后删除 Bun lockfile、Bun API、Bun shebang、OpenTUI 依赖和失效的平台代码，不保留双写或兼容 wrapper。

### 7. 安装器不默认分发 Node

- 安装脚本检测 Node.js 是否存在且版本至少为 20；不满足时失败并给出企业安装渠道提示。
- 默认安装路径不得访问公网下载 Node。企业若需要自动安装，可在后续 Spec 中定义由企业托管入口显式提供的可选 adapter，但不能成为仓库默认公网路径。
- Python 3.11+ 与 uv 的现有安装责任需在 Spec 中重新检视；本 Task 不将 Python Agent 打进 Node 包或改写为 TypeScript。

### 8. 平台范围不扩张

- 保持当前 macOS Intel/Apple Silicon、Linux glibc x64/arm64、Windows x64 范围。
- Linux musl 与 Windows ARM 不在本 Task 的新增支持范围；安装器必须继续清晰拒绝未支持组合。
- 自动化测试覆盖三类平台的路径、信号、子进程和终端契约；至少在可用企业 runner 上完成真实安装与对话证据。

## 范围

- 根工作区与各 JavaScript package 迁移为 npm workspaces，生成并维护唯一 `package-lock.json`。
- 将 CLI 入口、开发命令、生产构建、类型检查、测试和工程脚本切换到 Node.js `>=20`。
- 用 Ink `6.8.0` 重写 TUI composition root、时间线、动态区域、状态行、内联面板、选择器和 InputBar。
- 保留并清理 `InteractiveController` / `TuiAdapter` seam，使 presentation 类型不再引用 OpenTUI。
- 将 Web asset 构建替换为 Node 兼容 bundler，将 `Bun.serve` 替换为保持现有安全约束的 Node loopback HTTP/WebSocket server。
- 将 `bun:test` 测试迁移到企业源可用的 Node 20 兼容 test runner；静态渲染、输入流、长对话和终端恢复留下可重复检查。
- 将 Windows 终端处理从 `bun:ffi` 收敛到 Node 与标准终端能力；无法安全支持的增强能力明确降级，不能加载未批准的 native FFI。
- 更新安装脚本、README、用户文档、开发工作流、依赖清单以及相关架构文档。
- 在企业目标环境验证 npm registry、Node 启动 Python sidecar、stdio JSON-RPC 和 loopback Web server；失败必须形成可操作诊断。

## 非范围

- 改写 Python Agent、deepagents、LangChain、LangGraph、SQLite schema 或 JSON-RPC v3 业务契约。
- 同时维护 Bun/OpenTUI 和 Node/Ink 两套 Runtime 或两套 TUI Renderer。
- 在 Ink 上重新实现完整 OpenTUI、通用终端窗口系统、鼠标框架或可复用富文本编辑器。
- 保证与当前 OpenTUI 逐像素一致，或保留星空背景、鼠标 hover、常驻 Sidebar 等非核心视觉行为。
- 新增 Linux musl、Windows ARM、移动端、浏览器托管终端或远程 TUI 支持。
- 由默认安装器从公网安装 Node，或把 Node/Python Runtime 打进自包含大包。
- 借迁移改变模型、工具、审批、Thread、Plugin、Skill、MCP、Goal 或 Web 工作台业务语义。
- 升级 Ink 主版本、React 主版本，或引入 Pi TUI 作为第二条实验路径。

## 可观察验收

1. **零 Bun 依赖**：全仓库生产、开发、构建、测试、工程脚本和安装路径不要求 Bun；不存在有效的 Bun shebang、`Bun.*`、`bun:*` import、`bun:test`、OpenTUI 依赖或 Bun lockfile。
2. **标准 npm 安装**：干净环境通过企业 registry 执行 `npm ci` 可复现安装；依赖安装和 CLI 启动期间不回退公网下载 package、Runtime 或 native artifact。
3. **Node 版本矩阵**：同一份 `package-lock.json` 和同一份构建产物在 Node 20、22、24 上通过 CLI 启动、核心测试和一次完整对话；源代码不按 Node 主版本分叉。
4. **TUI 基本闭环**：用户能启动 Ink 界面、提交消息、看到流式正文和工具活动、处理审批或问题、取消运行并安全退出；退出后终端模式、光标和输入回显恢复正常。
5. **长会话行为**：已完成消息进入终端原生 scrollback，当前运行只更新动态区域；长 Thread 不因每次 token 到达而重绘全部历史，也不会因 `Static` 记录不可修改而丢失最终内容。
6. **InputBar 正确性**：中文、emoji、组合字符、多行输入、大段粘贴、Prompt history、Slash 命令、`@` 补全、Enter/换行和 Ctrl+C 在支持终端上行为一致，并具有纯逻辑测试与终端输入集成测试。
7. **交互能力保留**：审批、Question、Plan、Goal、模型/Thread/Skill/MCP/文件选择等现有可用流程均可通过键盘完成；取消鼠标与 Sidebar 后不存在只能由旧交互触达的核心能力。
8. **共享 Core 不分叉**：TUI 与 Web 继续使用同一个 `InteractiveController`、Selector 和状态；Renderer 不直接调用 AgentClient、RpcTransport 或 JSON-RPC method string。
9. **Web 安全不退化**：Node loopback server 保持随机端口、Host/Origin 校验、路由白名单、token 生命周期、CSP 和单窗口接管约束；Web handoff 可往返 TUI 且不新建第二个 Controller。
10. **Sidecar 生命周期**：Node CLI 能在目标企业环境启动、取消、回收 Python Agent；stdout 继续只承载 JSON-RPC JSONL，stderr 与诊断不污染协议帧；企业禁止子进程时给出明确失败原因。
11. **非 TTY 与异常恢复**：非 TTY 保持无头或明确拒绝语义；初始化失败、渲染错误、SIGINT/SIGTERM、sidecar 提前退出和 Web server 失败都能收敛资源并恢复终端。
12. **平台范围**：macOS、Linux glibc、Windows x64 的安装和运行契约有自动化覆盖及企业 runner/真机证据；Linux musl 与 Windows ARM 继续以明确错误拒绝，不能冒充已支持。
13. **安装与文档一致**：安装器只检测 Node.js `>=20` 并指向企业渠道，不默认公网下载；README、快速开始、交互使用和故障排查不再要求 Bun 或描述 OpenTUI 主路径。
14. **架构收敛**：完成时增量更新架构总览和 TUI 表现层文档，将 Node/npm/Ink 主屏渲染写成唯一 canonical 路径；HC-181 与 HC-145 保留为历史，不回写成未完成。

## 后续文档与版本影响

- 同名 Spec 使用 `spec-driven-development` 与 `codebase-design` 生成，固定 InputBuffer、时间线 committed/live 分区、按键、退出、Web server 和 npm package interface。
- Spec 确认后使用 `planning-and-task-breakdown` 生成同名 Plan / Todo，并按真实纵向能力设置可演示停点；实现一次只推进到下一个停点。
- 实现阶段必须使用测试驱动开发；Review 对照本 Task、Spec、Node 版本矩阵和企业环境证据执行。
- 本 Task 会取代 HC-181 中“Bun 全局包是唯一安装主路径”和 HC-145 中“OpenTUI 是唯一 TUI Renderer”的现状，但历史 Task 保持已完成记录，不删除或改写。
- Task 阶段不修改 `VERSION` 或 `CHANGELOG.md`；版本影响在 Spec / Plan 确认后决定。

## Task 阶段检查记录

- 2026-09-17：核验 Ink `6.8.0` 的 package metadata，最低 Node 为 20、React peer 为 `>=19.0`；当前 React `19.2.6` 可复用。
- 2026-09-17：确认 Node 20 已结束官方维护，因此将其定义为最低兼容基线，并要求同产物验证 Node 22、24。
- 2026-09-17：扫描当前实现，发现 23 个生产文件直接引用 OpenTUI、144 个测试文件引用 `bun:test`；迁移必须覆盖完整工程路径，不能按换包处理。
- 2026-09-17：用户接受主屏滚屏与键盘优先、完整移除 Bun、Node 由企业环境提供以及维持当前平台范围。
- 2026-09-17：用户确认同名 Spec 并要求生成 Plan / Todo；计划按五个可演示停点推进，一次实现只允许到下一个停点。
- 2026-09-17：用户确认开始开发；Task 已认领并建立实施分支。当前 npm registry 为公网源，且未发现企业 `.npmrc`、scope registry 或 registry 环境变量，因 P2 要求不得用公网源代替企业源，任务标记阻塞。
- 2026-09-17：用户明确覆盖上述开发门禁：本地开发可使用普通 npm registry，企业内部 registry 验证由用户在迁入后自行执行；Task 恢复为进行中。
- 2026-09-17：用户要求任何依赖版本变更必须先经其确认。当前 manifest/lockfile 中已写入但未获确认的候选版本只视为草案，禁止继续安装、升级、提交或据此完成停点；Task 阻塞于版本确认。
- 2026-09-17：用户确认企业可用的直接版本：npm `10.9.3`、Ink `6.8.0`、esbuild `0.28.2`、tsx `4.23.13`、Vitest `4.1.8`、ws `8.21.3`、string-width `8.2.2`、`@types/node` `20.19.35`、`@types/ws` `8.18.1`；其他既有依赖版本保持不变。Task 解除版本阻塞，后续任何直接版本变更仍须先请用户确认。
- 2026-09-17：停点 A 实现完成：npm/Node 工具链、Node bin、esbuild、Ink 最小对话、Unicode InputBuffer 与 committed/live Timeline 已落地；Node 20.20.2 下自动化检查通过，等待用户完成真实终端演示后再进入停点 B。
- 2026-09-17：npm 10.9.3 干净安装报告 3 个 moderate advisory，涉及已确认的 Vitest 4.1.8 与既有 Ajv 8.17.1；遵守版本变更需确认的约束，未自动升级或运行 audit fix。

## 一手参考

- [Ink 6.8.0 package metadata](https://raw.githubusercontent.com/vadimdemedes/ink/v6.8.0/package.json)
- [Ink 6.8.0 使用说明](https://raw.githubusercontent.com/vadimdemedes/ink/v6.8.0/readme.md)
- [Node.js 版本生命周期](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)
