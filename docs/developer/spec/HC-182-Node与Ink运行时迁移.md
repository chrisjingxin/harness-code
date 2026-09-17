# HC-182 Node 与 Ink 运行时迁移规格

关联任务：[HC-182](../task/HC-182-Node与Ink运行时迁移.md)  
历史安装路径：[HC-181](../task/archive/HC-181-CLI安装与分发.md)  
历史 TUI 路径：[HC-145](../task/archive/HC-145-TUI视觉与渲染重构.md)  
架构入口：[架构总览](../architecture/架构总览.md)、[TUI 表现层](../architecture/TUI表现层.md)

用户结果、范围与验收以 Task 为准。本文规定 Node/npm/Ink 的行为规格、Module、Interface、Seam、状态、错误语义、关键 invariant 与测试口径；不规定实施顺序。Plan / Todo 必须与本文同名，不得重新选择 Runtime、TUI 框架或交互形态。

## 1. Objective

Harness 当前把 Bun 同时用作包管理器、TypeScript Runtime、构建器、测试运行器、HTTP/WebSocket server 和 OpenTUI 的宿主。企业环境无法稳定启动 Bun，因此仅把安装命令从 `bun install` 改为 `npm install` 不能解决问题。

本功能交付一个单一 canonical 路径：

```text
npm 安装 @za38/cli
  → Node.js >=20 执行预编译 CLI
  → Node child_process 启动现有 Python sidecar
  → InteractiveController 继续拥有业务状态
  → TuiAdapter 把 snapshot / intent 暴露给 Ink
  → Ink 在主屏输出已完成历史，并只重绘当前动态区域
```

成功后，用户在 Node 20、22、24 上运行同一个 CLI 包，使用完整的对话、流式输出、工具活动、审批、问答、Plan、Goal、命令、Thread 恢复和 Web handoff；构建、测试、安装和运行均不再需要 Bun。Python Agent、JSON-RPC v3、SQLite 和共享 Interactive Core 的业务语义不变。

## 2. 已确认决策与术语

以下决策来自已确认 Task，Spec 不得改写：

1. 唯一 JavaScript Runtime 是 Node.js `>=20`；不设置主版本上限，不维护按 Node 主版本分叉的实现。
2. TUI 固定 Ink `6.8.0`；React 固定现有 `19.2.6`。不保留 OpenTUI、Pi TUI 或 Bun fallback。
3. TUI 采用主屏滚屏、键盘优先和内联面板；不复刻全屏 ScrollBox、鼠标系统、浮层窗口或常驻 Sidebar。
4. 同一 Task 完整迁移包管理、构建、测试、Web server、工程脚本、安装器和文档。
5. Node 由企业环境提供；安装器只检测，不默认下载 Node。Python 3.11+ 与 uv 的现有安装责任不因本功能取消。
6. 平台范围维持 macOS x64/arm64、Linux glibc x64/arm64、Windows x64；不新增 Linux musl 与 Windows ARM。
7. Node 20 是最低兼容基线，不是安全推荐版本；企业没有延长维护时，生产优先使用 Node 22 或 24。

术语固定如下：

| 含义 | 术语 | 禁止用语 |
| --- | --- | --- |
| 底部输入界面 | 输入栏 / `InputBar` | Composer（与 Compose 工作模式混淆） |
| 输入文字与光标的纯状态机 | `InputBuffer` | editor framework |
| 已经输出到终端、以后不再改变的记录 | committed entry / 已提交记录 | scrollbox item |
| 仍会因流式事件变化的记录 | live entry / 活动记录 | mutable static item |
| 临时占据动态区域的状态、文件、工具等界面 | 全宽临时视图 | Overlay / Sidebar |

## 3. Capability Map 与依赖方向

HC-182 只维护本文这一份 Spec。下表用于固定内部 Module id 和依赖方向，不拆成多套 Spec。

| Module id | 职责 | 依赖 |
| --- | --- | --- |
| `node-toolchain` | npm workspace、Node 入口、构建、类型检查、测试和工程脚本 | 无 |
| `node-platform` | child process、TTY、信号、模块路径、诊断、HTTP/WebSocket 等 Node Adapter | `node-toolchain` |
| `input-buffer` | Unicode 安全的多行输入、光标、粘贴与编辑 effect | `node-toolchain` |
| `ink-presentation` | Ink 生命周期、committed/live 时间线、InputBar、内联面板与全宽临时视图 | `node-platform`、`input-buffer`、现有 Interactive Core |
| `web-runtime` | 预构建 Web assets 与 Node loopback HTTP/WebSocket Adapter | `node-toolchain`、`node-platform`、现有 PresentationCoordinator |
| `npm-distribution` | npm 包形状、安装器、平台检查、自检与文档 | 前述全部 Module |

依赖只能沿表中方向流动。`InteractiveController`、Selector 和 `presentation-shared` 不得反向 import Ink、Node Web server 或安装实现。

## 4. Tech Stack 与依赖契约

### 4.1 固定基线

| 项目 | 规格 |
| --- | --- |
| Node.js | `>=20`；构建目标和类型基线为 Node 20 |
| npm | 精确 `10.9.3`；根 lockfile 固定为 `package-lock.json` lockfile v3 |
| Ink | 精确 `6.8.0` |
| React / React DOM | 精确 `19.2.6` |
| TypeScript | 保留仓库当前 `6.0.3`；`@types/node` 精确 `20.19.35`，不跟随本机 Node |
| CLI / Web bundler | `esbuild` 精确 `0.28.2` |
| TS 开发脚本执行 | `tsx` 精确 `4.23.13`，仅 devDependency |
| TypeScript 测试 | Vitest 精确 `4.1.8` |
| WebSocket server | `ws` 精确 `8.21.3`，`@types/ws` 精确 `8.18.1`；作为 CLI 直接依赖 |
| Unicode 显示宽度 | `string-width` 精确 `8.2.2`，作为 InputBuffer/布局的直接依赖 |

`esbuild`、`tsx`、Vitest 和 `ws` 的最终 patch 版本必须在实施前通过当前 npm registry 的真实可用版本确定，并在 `package.json`、`package-lock.json` 与 `docs/developer/project/dependency-versions.json` 中精确锁定，不使用 `^`/`~`。任何候选版本都必须声明支持 Node 20。企业 registry 可用性不再作为本地实施前置门禁，由用户迁入后使用同一 lockfile 执行验收；产品运行和安装仍不得实现 registry 公网 fallback。

### 4.2 依赖删除与保留

必须删除：

- `@opentui/core`
- `@opentui/react`
- 仅为 OpenTUI 直接声明的 `react-reconciler`
- `@types/bun`
- `@types/react-reconciler`（没有其它直接调用方时）
- Bun native optional packages、Bun lockfile 与 Bun FFI artifact

继续保留并迁移：

- `@za38/protocol`：源码 workspace 依赖使用与包版本一致的普通 SemVer，不使用 `workspace:*`；生产 CLI bundle 继续内联它。
- `marked`：解析 Markdown 结构。
- `shiki`：TUI/Web 离线代码高亮；运行期不得下载语言或主题。
- `happy-dom`：Web DOM 测试。
- `@colbymchenry/codegraph`：维持 HC-180 固定版本和受管子进程语义；必须额外证明其 Node 20 启动路径不访问公网。

### 4.3 安装期网络 invariant

- `npm ci` 与 `npm install -g` 只访问用户指定的企业 registry。
- 项目及直接依赖不得在 postinstall 中从 GitHub、官方 CDN 或其它公网下载二进制、WASM、语法文件或 Runtime。
- esbuild 等平台包由企业 registry 镜像；缺平台包时安装失败并指出包名，不启动下载 fallback。
- CLI 运行期不执行 npm、不解析远端版本、不安装缺失依赖。

## 5. 总体架构与 Seam

```text
CLI Composition Root（Node）
  ├─ Agent process Adapter ── stdio JSON-RPC v3 ── Python AgentHost
  ├─ InteractiveController（保留）
  │    ├─ TuiAdapter（收窄 Interface）
  │    │    └─ InkRoot
  │    │         ├─ StaticTranscript
  │    │         ├─ LiveRegion
  │    │         ├─ BottomArea
  │    │         └─ TemporaryView
  │    └─ WebUiGateway（保留）
  │         └─ Node PresentationServer Adapter
  └─ shutdown：Web → Workspace → Coordinator → Controller → Agent
```

### 5.1 保留的深 Module

`InteractiveController` 继续拥有 Run、Thread、模型、Skill、MCP、命令、Interaction 和 Timeline 业务状态。TUI 与 Web 都只消费它派生的 snapshot 并派发 typed intent。

`TuiAdapter` 的 external Interface 保持小而稳定：

```ts
interface TuiAdapter {
  getSnapshot(): TuiAdapterSnapshot
  subscribe(listener: (snapshot: TuiAdapterSnapshot) => void): () => void
  dispatch(intent: TuiIntent): Promise<void>
  showToast(message: string, variant?: ToastVariant, durationMs?: number): void
  close(): Promise<void>
}
```

调用方不需要知道 OpenTUI/Ink ref、终端坐标、WebSocket、AgentClient 或 JSON-RPC method string。这个 Interface 同时是 Adapter 单测的主要 test surface。

### 5.2 需要收窄的 TUI Interface

`TuiAdapterSnapshot` 与 `TuiIntent` 必须移除 Renderer 泄漏和已取消交互：

- 删除 `KeyEvent`、`TextareaRenderable`、`ScrollBoxRenderable` 及其它 OpenTUI 类型。
- 删除 conversation `scrollRequest`；主时间线不再接受应用内滚动 intent。
- 删除 command/mention/picker 的 mouse hover intent；选择只由键盘语义动作驱动。
- 删除 Sidebar 的宽度、停靠、鼠标开关和焦点切换状态。
- 删除 selection-copy 的 Renderer 选区状态和 mouse-up intent。
- 工作区浏览、文件预览、状态、BTW、Inspect 和工具详情保留为语义状态，但投影为全宽临时视图，而不是像素/浮层位置。

允许新增的 intent 只描述用户意图，例如 `workspace-open`、`temporary-view-close`、`workspace-navigate`、`tool-inspector-open`；不得传入按键对象、Ink instance 或终端尺寸。

### 5.3 两个真实 Adapter Seam

本功能只在已有真实变化点放 Seam：

1. `TuiAdapter` Seam：现有 Web Adapter 与新的 Ink Adapter/Presentation 是两个消费者；Interface 保持表现层无关。
2. `PresentationServer` / `GatewayChannel` Seam：用 Node HTTP/WebSocket Adapter 替换 Bun Adapter；Coordinator 不感知底层 server 类型。

不得为了一个实现引入 renderer factory、terminal driver hierarchy 或 package-manager interface。

## 6. `node-toolchain` 规格

### 6.1 Workspace 与 package manifest

根 `package.json`：

- `packageManager` 指向企业采用的精确 npm 10.x 版本；`engines.node` 为 `>=20`，`engines.npm` 为 `>=10`。
- `workspaces` 继续包含 `packages/*`。
- 唯一 lockfile 是根 `package-lock.json`；删除 `bun.lock`。
- workspace 之间使用普通精确 SemVer；禁止 `workspace:*`。
- scripts 全部通过 `npm run` 执行，不包含 `bun`、`bunx` 或隐式公网 `npx`。

发布后的 `@za38/cli`：

- `bin.harness` 与 `bin.za38` 都指向 `dist/bin.js`。
- `dist/bin.js` 使用 `#!/usr/bin/env node`。
- 先验证 Node major `>=20`，再动态加载主 CLI；低版本只输出简短错误并退出 1，不加载 Ink 或 sidecar。
- 生产包不依赖 TypeScript、tsx、Vitest 或 esbuild。

### 6.2 入口与模块路径

- `src/index.ts` 只导出 `main(argv)` 和可测试的 composition 函数，不再使用 `import.meta.main`。
- 独立 `src/bin.ts` 负责调用 `main()`、格式化顶层错误和设置 `process.exitCode`。
- 所有 `import.meta.dir` 通过一个 Node URL/path helper 收敛为 `fileURLToPath(import.meta.url)` 和 `dirname()`；调用方不重复拼接。
- 诊断 Runtime 从 `bun-<version>` 改为 `node-<process.versions.node>`。
- `tsconfig` 移除 `jsxImportSource: "@opentui/react"` 和 `types: ["bun"]`，加入 Node 20 类型；JSX 使用 React automatic runtime。

### 6.3 Build interface

`npm run build` 必须产生完整可发布 `packages/cli/dist/`：

```text
dist/
├─ bin.js                    Node shebang 入口
├─ cli.js                    CLI implementation bundle（文件名可与 bin 合并）
├─ web.js
├─ web.css
├─ web-syntax-worker.js
├─ web-assets.json
└─ runtime assets            只含 manifest 声明的离线资源
```

具体文件是否合并由实现决定，但以下行为固定：

- CLI target 为 `node20`、format 为 ESM、platform 为 node。
- workspace 内部代码与 protocol 可 bundle；Ink、React、React DOM、ws、Shiki 等声明的 Runtime dependency 保持 external，由 npm 正常解析。
- Web app 与 syntax worker target 为 browser，禁止把 Node builtin 或 secret 注入 browser bundle。
- 构建输出可重复；同一源码与 lockfile 不因本机 Node 20/22/24 产生不同逻辑产物。
- Web assets 在 build/dev 启动前生成；生产运行时的 `/web` 不调用 esbuild。

### 6.4 Test runner 迁移

- 所有 `bun:test` import 迁移到 Vitest；禁止长期保留兼容 shim。
- `Bun.file` 改用 `node:fs/promises`，`Bun.spawn` / `spawnSync` 改用 `node:child_process`。
- fake timers、spy、mock 使用 Vitest 的直接能力，不建立一层仿 Bun test interface。
- 工程脚本和 protocol generator 由 `tsx` 执行；生产 CLI 不 import `tsx`。

## 7. `node-platform` 规格

### 7.1 Python sidecar

现有 `startAgent` 的进程解析顺序、cwd、env、stderr 日志和 stdio JSON-RPC 行为保持 HC-181/当前实现语义。变化仅限 Runtime Adapter：

- 使用 `node:child_process.spawn`，stdio 固定为 `pipe`。
- spawn 后缺任一 stdin/stdout/stderr 立即终止子进程并失败。
- CLI Connection close、EOF、SIGINT/SIGTERM 和顶层异常最终都回收子进程。
- 不能启动子进程时，错误明确区分「可执行文件不存在」「权限/企业策略拒绝」「进程启动后退出」。不得把企业策略问题误报为模型连接失败。
- Python stdout 继续只接受逐行 JSON-RPC；诊断写 stderr，不因 Node 迁移放宽帧解析。

### 7.2 TTY 与信号

- 交互模式仍要求 stdin/stdout 为 TTY；否则提示使用无头模式。stderr 是否为 TTY 不影响普通交互启动，但需要隐藏输入的命令继续按原安全规则检查。
- Ink 以 `exitOnCtrlC: false` 启动，Ctrl+C 全部走 Harness 快捷键状态机。
- `setRawMode(true)` 失败时不得半渲染；输出错误、恢复已改变的终端状态并退出 1。
- 进程只注册一组退出 handler；重复 close 幂等。
- Windows 删除 `bun:ffi` 与私有 VT guard，依赖 Node TTY 与 Ink 的标准输入能力。增强键盘协议不可用时按本 Spec 的 fallback 键位降级。

### 7.3 Terminal size Module

Ink `6.8.0` 不假设存在 `useWindowSize`。实现一个小的内部 Module：

```ts
type TerminalSize = { columns: number; rows: number }

interface TerminalSizeSource {
  getSnapshot(): TerminalSize
  subscribe(listener: (size: TerminalSize) => void): () => void
}
```

生产 Adapter 读取 stdout `columns` / `rows` 和 `resize` 事件；测试 Adapter 手动推送尺寸。尺寸缺失时使用保守默认值，只影响换行和列表窗口，不得改变业务状态。

## 8. `input-buffer` 规格

### 8.1 深 Module Interface

`InputBuffer` 是纯 Module。调用方只提交标准化编辑事件并消费 state/effect：

```ts
type InputBufferState = {
  value: string
  cursorOffset: number
  preferredColumn?: number
}

type InputEffect =
  | { type: "none" }
  | { type: "submit"; value: string }

function reduceInput(
  state: InputBufferState,
  event: InputEvent,
): { state: InputBufferState; effect: InputEffect }
```

`InputEvent` 覆盖 insert、paste、backspace、delete、move-left/right/up/down、home/end、newline、submit 和 replace-from-history。不得为每个按键暴露一个公开方法；Ink key mapping 属于 InputBar implementation。

### 8.2 Unicode 与显示宽度 invariant

- `cursorOffset` 使用 JavaScript UTF-16 offset 以兼容现有 draft Interface，但必须始终位于 grapheme boundary，不能落在 surrogate pair、组合字符或 ZWJ emoji 中间。
- grapheme 分段使用 Node 20 的 `Intl.Segmenter`；终端 cell width 使用直接依赖 `string-width@8.2.2`。
- 上下移动保留目标显示列；宽字符、tab 和多行文本不能让光标越界。
- CRLF 与 CR 在输入时规范为 LF；NUL 和不能显示的控制字符不进入 draft。
- InputBar 最多显示光标附近 6 个视觉行；隐藏的输入行显示明确计数。完整 draft 保留在 InputBuffer/TuiAdapter，不因绘制窗口截断。

### 8.3 输入与粘贴

- 单个可打印输入插入光标位置。
- Ink 一次回调交付多个字符或包含换行时按 paste 处理；paste 永远只插入文本，不触发 submit、快捷键、Slash 执行或 Shell 模式切换。
- paste 中 CRLF/CR 规范为 LF；保留普通换行和 tab；去除 NUL/ESC 等控制序列。
- 大段粘贴不得为每个字符发布 snapshot；一次 paste 至多产生一次 draft 更新。

### 8.4 固定键位

| 输入状态 | 键位 | 行为 |
| --- | --- | --- |
| 普通输入 | Enter / keypad Enter | 提交；空白不提交 |
| 普通输入 | Shift+Enter | 插入换行（终端能报告 modifier 时） |
| 普通输入 | Alt+Enter 或 Ctrl+J | 无增强键盘协议时的换行 fallback |
| 普通输入 | Left/Right | 按 grapheme 移动 |
| 普通输入 | Up/Down | 多行内上下移动；仅在完整 draft 起点/终点进入 Prompt history |
| 普通输入 | Home/End | 当前逻辑行首/行尾；Ctrl+Home/End 到全文首尾 |
| 普通输入 | Backspace/Delete | 按 grapheme 删除 |
| draft 非空 | Ctrl+C | 第一次只清空 draft，不取消 Run |
| draft 为空且 Run 活动 | Ctrl+C | 取消 Run |
| draft 为空且无 Run | Ctrl+C / Ctrl+D | 退出 Harness |
| chat draft 为空 | `!` | 进入 Shell 输入模式，不插入 `!` |
| Shell draft 为空 | Esc / Backspace | 返回 chat 模式 |
| 无菜单、无 draft、无 Run | Tab | 切换 Build/Compose |
| 无菜单 | Shift+Tab | 循环审批模式 |
| 任意临时视图/菜单 | Esc | 只关闭最上层视图，不取消 Run |

Ink render 使用 `kittyKeyboard: { mode: "auto" }`。增强协议不可用时，用户仍可用 fallback 换行；不能因为终端分不清 Shift+Enter 就把换行误提交。

### 8.5 菜单优先级

Command、mention、picker、Interaction 先于 InputBar 消费导航键。沿用现有优先级：

```text
确认/Interaction
  → 临时视图
  → picker
  → command menu
  → mention menu
  → InputBar
  → 全局快捷键
```

Tab/Enter 在有候选项时选择候选；无候选时阻止误提交。`Ctrl+P/N` 继续作为 Up/Down 的菜单替代键。

## 9. `ink-presentation` 规格

### 9.1 Ink 生命周期

`runTui(options): Promise<void>` 对 CLI Composition Root 的 Interface 保持不变。内部 render 选项固定为：

```ts
{
  exitOnCtrlC: false,
  incrementalRendering: true,
  maxFps: 30,
  kittyKeyboard: { mode: "auto" },
}
```

- `runTui` 创建且只创建一个 TuiAdapter、一个 Ink root 和一组 terminal handler。
- Promise 只在 root unmount、raw mode/cursor 恢复、TuiAdapter close 和 TUI 私有资源关闭后 resolve。
- TUI render error 进入一个 React error boundary，输出脱敏错误并请求同一关闭路径；禁止留下 raw mode。
- 不进入 alternate screen，不发送鼠标追踪控制序列。

### 9.2 committed/live 时间线

`InkTimelineProjector` 是 Renderer 私有的深 Module：

```ts
interface InkTimelineProjector {
  update(view: ConversationView): {
    newlyCommitted: readonly RenderEntry[]
    live: readonly RenderEntry[]
  }
  close(): void
}
```

内部可维护 emitted id/revision，但调用方只看到本帧应追加到 `Static` 的记录和应继续动态渲染的记录。

记录提交规则：

| Timeline 类型 | committed 条件 |
| --- | --- |
| user message | 输入已被 Core 接受，正文和 mode 已固定 |
| assistant message | 对应流结束或 Run 到达终态，正文不再追加 |
| reasoning | 已冻结且摘要/正文不再追加 |
| tool | completed / failed / cancelled，展示 view model 已固定 |
| interaction | 已经产生最终结果行；pending 控件永远属于 live BottomArea |
| system event / run footer | 事件已进入 Timeline 且内容固定 |
| run progress | 永远 live，不写 Static |

必须始终成立：

1. 同一稳定 entry id 最多写入 `Static` 一次。
2. 同一 entry 不得同时出现在 committed 与 live。
3. 已 committed 的内容不得因展开、主题、窗口 resize、Web handoff 或后续 snapshot 改写。
4. 活动 assistant/reasoning/tool 在最终 delta 到达前保持 live；先生成最终 view model，再 commit。
5. Thread 恢复得到的历史记录在首次挂载时按既有顺序 commit 一次；后续 snapshot 不能重复打印。
6. 对话历史只做一次 O(n) 投影；流式 token 更新只重算当前 live 尾部和有界状态，不遍历/重绘已 committed React tree。

### 9.3 视图结构

```text
InkRoot
├─ StaticTranscript          已完成记录，一次写入终端 scrollback
├─ LiveRegion               当前 assistant/reasoning/tool/run progress
├─ BottomArea               同时一个输入面
│   ├─ InputBar
│   ├─ ApprovalPanel
│   ├─ DirectoryTrustPanel
│   ├─ QuestionPanel
│   ├─ PlanPanel
│   └─ GoalPanel
├─ TemporaryView            同时最多一个全宽临时视图
└─ StatusLine               mode/model/approval/cwd/活动状态
```

BottomArea 继续复用现有 `bottomAreaKind` 纯决策；pending Interaction 优先于 InputBar。Interaction 决策集合、顺序和授权语义继续来自 `presentation-shared/interaction-policy.ts`。

### 9.4 历史、Markdown、Tool 与 Diff

- 用户消息、assistant、reasoning、tool、system event 与 run footer 的语义样式沿用 HC-145；删除 OpenTUI tag、绝对定位和鼠标 handler。
- Markdown 使用 `marked` 结构化解析后映射为 Ink `Text` / `Box`；代码 token 使用已经初始化的离线 Shiki highlighter。
- TUI highlighter 在 root 首次 render 前完成初始化；初始化失败后本次进程固定降级纯文本，不得在记录 commit 后异步换色重写 Static。
- 未知语言、超长代码和高亮错误退回纯文本。运行期不访问网络。
- Tool 仍通过现有 `resolveToolRenderer` 和 `presentation-shared` view model 分流；未知 Tool 必须 generic。
- Diff 使用共享 unified/split 数据；主屏默认 unified。临时详情视图在宽度足够时可以 split，但审批授权不依赖高亮成功。
- 思考、工具输出和代码仍使用现有 paint budget；完整原文保留在 Core/Artifact，Static 只输出有界视图。

### 9.5 全宽临时视图

取消 Overlay 与 Sidebar 后，以下内容在 LiveRegion/BottomArea 之上显示为全宽临时视图，但不清除已经输出的 terminal scrollback：

| 入口 | 视图 | 键盘 |
| --- | --- | --- |
| `/status` | 现有状态仪表盘 | Esc/Enter/q 关闭；PgUp/PgDn/Home/End 翻页 |
| `/btw` | 临时问答结果 | Esc/Enter 关闭；`c` 执行显式 copy |
| `/plan-view`、Goal/Inspect | 现有只读正文 | Esc 返回；可分页 |
| `Ctrl+B` | 工作区文件浏览 | ↑↓/j k 选择，←→ 展开，Enter 预览，`@` 插入引用，Esc 返回 |
| `Ctrl+O` | Tool Inspector | ↑↓ 选择最近 Tool，Enter 查看，Esc 返回 |
| `/model`、`/resume`、Skill/Agent/Undo | 内联 picker | ↑↓/Ctrl+P/N，Enter/Tab 选择，Esc 关闭 |

工作区浏览复用现有 `WorkspaceExplorer`，但不保留宽度比例、dock/overlay 断点、鼠标滚轮和 Sidebar tab。`/status` 已覆盖状态信息，不再维护独立 Sidebar 状态页。

Tool Inspector 替代“点击历史卡片原地展开”：已 committed 的 Tool 摘要不变，Inspector 从当前 snapshot/Timeline view model 展示所选 Tool 的有界详情。它不能重新执行 Tool，也不能修改 Transcript。

### 9.6 Terminal selection 与 clipboard

- 普通历史文本复制交给终端原生选择；删除 OpenTUI selection API、mouse-up 自动复制和 Windows `bun:ffi` 路径。
- Harness 不拦截鼠标事件，不显示“自动复制成功” Toast。
- `/btw` 的 `c` 等明确 copy 操作可继续调用现有系统 clipboard Adapter；失败只显示提示，不影响内容阅读。
- InputBar 第一阶段不提供范围选择、剪切或 rich clipboard；用户可编辑、清空和粘贴完整文本。

### 9.7 Web handoff

Ink root 和 `InkTimelineProjector` 在 `opening-web` / `web-active` / `returning-tui` 期间保持同一实例，不重建 Controller、TuiAdapter 或 emitted 集合：

```text
tui-active
  → opening-web：InputBar 仍按现有租约规则工作
  → web-active：冻结终端 Timeline 输出，只显示“Web 已接管”动态提示
  → returning-tui：提交 Web 期间新增且已完成的记录，恢复 live 尾部与输入
  → tui-active
```

Web active 期间不得把 Browser 中产生的每个 token 同时刷到终端；返回时只补一次最终/当前状态。这样既避免重复 scrollback，也保持同一个 Controller 和完整 Timeline。

## 10. `web-runtime` 规格

### 10.1 Web assets

- `esbuild` 在 `npm run build` / `npm run dev` 启动前生成 app、CSS 和 syntax worker。
- `browserBundle()` 在运行时只读取 `web-assets.json` 白名单中的 dist 文件；删除源码路径的 `Bun.build` fallback。
- manifest 仍只接受 dist 内普通相对路径，拒绝绝对路径、`..` 与缺失文件。
- 发布包缺 asset 或 manifest 无效时，`/web` 返回可操作错误，TUI/无头核心继续可用；不得临时联网构建。

### 10.2 Node PresentationServer Adapter

实现使用 `node:http` 与 `ws.WebSocketServer({ noServer: true })`，继续满足现有 `PresentationServer` 和 `GatewayChannel` Interface。

- 只监听 `127.0.0.1`，让 OS 分配随机端口；不监听 `0.0.0.0`、IPv6 wildcard 或局域网地址。
- HTTP 路由白名单保持 `/web/h/<id>`、`/web/app.js`、`/web/app.css`、`/web/syntax-worker.js` 与 `/web/h/<id>/ui`。
- 精确校验 Host、method、upgrade、Origin、handoff id 和一次性 token；验证成功前不调用 WebSocket upgrade。
- 禁用 per-message deflate，使用现有 Browser frame 上限配置 `maxPayload`；二进制帧、超限帧和畸形 UTF-8 进入现有 invalid-message 关闭路径。
- 不记录包含 `ui` query token 的 URL，不接入 access log。
- CSP、no-store、no-referrer、nosniff、same-origin 与 COOP header 保持当前值。
- `stop()` 幂等：拒绝新连接、关闭活跃 WebSocket、等待 HTTP server close；不能因失效连接挂住 CLI 退出。

### 10.3 安全 invariant

迁移不得改变 Coordinator 的 bootstrap token、reconnect token、单窗口、ready timeout、重连宽限、revision 门禁或输入租约语义。Node Adapter 测试必须复用现有攻击用例：错误 Host/Origin/token、第二窗口、token 重放、畸形帧、超限帧和关闭竞态。

## 11. `npm-distribution` 规格

### 11.1 用户安装 Interface

macOS / Linux 仍使用企业托管的 shell 安装入口；Windows 仍使用企业托管的 PowerShell 入口。脚本步骤改为：

```text
识别 OS/arch；不支持则失败
  → 检查 node --version >=20；缺失/过低则失败并指向企业 Node 渠道
  → 检查 npm >=10；缺失/过低则失败并提示更新企业 Node/npm
  → 按现有语义检查或补齐 uv 与 Python 3.11+
  → npm install -g @za38/cli@<version> --registry <企业 npm>
  → uv tool install za38-agent==<version> --index <企业 PyPI>
  → 处理 npm global bin 与 uv tool bin 的 PATH
  → harness --version 自检
```

- 删除 Bun 检测、Bun 下载 URL、Bun PATH 和 `bun install -g`。
- 不增加默认 Node 下载 URL；缺 Node 时不得尝试 curl/PowerShell 公网安装。
- npm registry、PyPI、uv 安装地址继续允许企业配置；输出不得泄露凭据。
- 已有配置不覆盖；API Key 不由安装器写入。

### 11.2 手动安装与卸载

```bash
npm install -g @za38/cli@<version> --registry <企业 npm>
uv tool install za38-agent==<version> --index <企业 PyPI>

npm uninstall -g @za38/cli
uv tool uninstall za38-agent
```

卸载不删除 Node、npm、uv、Python、用户配置、Thread 数据或日志。

### 11.3 发布包

- CLI tarball 包含 dist、运行资产、package manifest 和许可证；不包含 src、tests、构建器、缓存或企业凭据。
- `dependencies` 精确声明 Ink、React、React DOM、ws、string-width、marked、Shiki 等运行时依赖。
- `devDependencies` 不进入用户主依赖路径；CLI 自身不得有联网 postinstall。
- CLI 与 Python Agent 继续使用根 `VERSION` 同一 SemVer；安装器 `--version` 同时固定两包。
- `npm pack --workspace @za38/cli` 的文件清单测试取代 `bun pm pack`。

## 12. 状态机与关键 invariant

### 12.1 TUI 状态优先级

同一时刻用户输入只属于一个 owner：

```text
Web input lease
  > pending Interaction panel
  > temporary view / confirmation
  > picker / command / mention menu
  > InputBar
  > global shortcut
```

低优先级 owner 不得在高优先级界面打开时偷偷处理 Enter、Esc、Tab、方向键或 Ctrl+C。

### 12.2 必须始终成立

1. 生产和开发 canonical scripts 不执行 Bun；仓库中历史文档可保留旧命令，活动入口和自动化不得保留。
2. Node 20/22/24 使用同一源码、lockfile、CLI tarball 和实现路径。
3. TUI/Web 只通过 InteractiveController/TuiAdapter Interface 改变业务状态。
4. Ink/React ref、终端坐标和按键对象不得进入 Interactive Core 或 Protocol。
5. 已 committed 的终端记录只输出一次且以后不可变。
6. pending Interaction 同时最多一个可聚焦 BottomArea；InputBar 在此时不接收文字。
7. 粘贴文本永远不执行提交、命令或 Shell shortcut。
8. Ctrl+C 的清 draft → 取消 Run → 退出优先级稳定。
9. 无鼠标时所有核心流程均可通过键盘完成。
10. Web server 只绑定 loopback，未通过校验的请求不能升级或消费 token。
11. shutdown 顺序保持 Web channel → WorkspaceExplorer → Coordinator → Controller → Agent；各 close 幂等。
12. stdout 的 Python sidecar 协议与 CLI 普通输出不得互相污染。
13. TUI 渲染/高亮失败不能改变审批授权、Tool 执行结果或 Transcript。
14. 安装与启动不允许隐式公网自愈。

## 13. 错误语义与降级

| 情况 | 规定行为 |
| --- | --- |
| Node <20 | `dist/bin.js` 在加载 Ink 前退出 1，说明要求 Node `>=20` 与当前版本 |
| npm/企业 registry 缺依赖 | 安装失败并指出缺失包；不换 registry、不公网下载、不退回 Bun |
| stdout/stdin 非 TTY | 保持现有交互拒绝信息并提示无头模式 |
| raw mode / Ink 初始化失败 | 恢复已改变终端状态，stderr 输出脱敏错误，退出 1；不启动第二 Renderer |
| enhanced keyboard 不可用 | 使用 Alt+Enter/Ctrl+J 换行 fallback，其余按键继续工作 |
| Unicode width/highlight 失败 | 当前块退回保守纯文本；draft 与业务数据不丢失 |
| Python spawn 被企业策略拒绝 | 明确提示子进程启动被拒绝，停止 CLI；不误报配置或模型错误 |
| Python sidecar 提前退出 | 保持现有 agentExit/终态错误和资源回收 |
| Web asset 缺失/损坏 | `/web` 失败并返回 TUI；不在线构建、不退出整个 Harness |
| loopback bind 被禁止 | `/web` 给出企业策略相关错误，TUI 继续可用 |
| WebSocket 校验/帧错误 | 拒绝或关闭该 handoff，按现有 Coordinator 语义回到 TUI |
| TemporaryView 内容过长 | 有界分页；不把完整内容每帧重绘 |
| terminal resize | 重新计算 live/临时视图布局；不重新打印 committed 历史 |
| SIGINT/SIGTERM/顶层异常 | 进入唯一幂等 shutdown，恢复终端并回收 sidecar |

错误文本不得包含 API Key、认证 Header、带凭据 registry URL、完整 Web token、完整 Prompt 或未脱敏工具结果。

## 14. Commands

迁移后的 canonical 命令：

```bash
npm ci
npm run dev -- [harness 参数]
npm run build
npm run typecheck
npm test
npm run test:ts -- --run <focused test files>
npm run test:py
npm run protocol:generate
npm run protocol:check
npm run tasks:sync
npm run tasks:check
npm run docs:check
npm run project:check
npm run test:web:e2e
npm pack --workspace @za38/cli
```

- `npm run dev -- --non-interactive --message "..."` 必须把 `--` 后参数原样交给 CLI。
- `npm test` 顺序覆盖 project scripts、TS tests 和 Python tests；单项失败返回非 0。
- `npm run build` 不执行测试；`npm run project:check` 继续检查 protocol、文档、Task、版本与 changelog 一致性。
- 自动化脚本不得使用无版本约束的 `npx`。Playwright 通过 workspace devDependency 的本地 binary 执行。

## 15. Project Structure

目标目录职责如下；Plan 可以在不改变 Module Interface 的前提下调整具体文件名：

```text
packages/cli/src/
├─ bin.ts                         Node shebang/版本门禁/顶层错误
├─ index.ts                       CLI composition root
├─ platform/node/                 module path、TTY、signal、process Adapter
├─ tui/
│  ├─ app.tsx                     Ink root 与生命周期
│  ├─ application/adapter.ts      表现状态与语义 intent（保留并收窄）
│  ├─ input/input-buffer.ts       纯编辑状态机
│  ├─ input/key-mapping.ts        Ink input → InputEvent
│  └─ presentation/               Static/Live/InputBar/Panel/TemporaryView
├─ web/
│  ├─ bundle.ts                   只读 built assets
│  └─ server.ts                   node:http + ws Adapter
└─ presentation-shared/           两端共享纯策略，禁止 import ink/node server

packages/cli/tests/
├─ tui/input/                     InputBuffer、paste、Unicode、key mapping
├─ tui/presentation/              Static/live、BottomArea、temporary views
├─ web/                           Node server 与安全回归
├─ infrastructure/               Node process/path/TTY Adapter
└─ acceptance/                    build/package/Node matrix 行为

scripts/project/                  由 tsx 执行的工程脚本
scripts/install/                  npm + uv 安装入口
docs/user/                        用户安装、交互与故障排查
docs/developer/architecture/      完成时更新 canonical 架构
```

不得保留 `tui/platform` 中只为 OpenTUI native Renderer 存在的代码。仍有通用价值的 syntax、clipboard、workspace helper 应移动到符合职责的位置，而不是保留误导目录名。

## 16. Code Style

TypeScript 继续使用 ESM、2 空格缩进、中文文件说明和中文公开 JSDoc。Interface 只携带调用方必须知道的语义：

```ts
/** 将标准化输入事件归约为新状态；不读取终端、React 或全局进程。 */
export function reduceInput(
  state: InputBufferState,
  event: InputEvent,
): InputTransition {
  if (event.type === "paste") return insertText(state, normalizePaste(event.text))
  return reduceEditingEvent(state, event)
}
```

禁止的形状：

```ts
// 禁止：把 Ink key、ref、Controller 和 Node stream 全塞进一个浅 Interface。
function handleEverything(key: InkKey, inputRef: unknown, controller: InteractiveController): void
```

原则：

- Node/Ink 差异留在 Adapter implementation，纯策略返回结果而不是直接副作用。
- 同一规则只实现一次：按键优先级、timeline commit、Host/Origin 校验、shutdown 顺序都必须有唯一 owner。
- 不新增一个实现对应一个 factory/interface；只有真实可替换的 Seam 才保留 Interface。
- 生产源码继续遵守中文说明与公开函数文档要求。

## 17. Testing Strategy

### 17.1 单元测试

- `InputBuffer`：ASCII、中文、emoji、ZWJ、组合字符、宽字符、换行、上下移动、删除、history replace、paste 不提交。
- shortcut/key mapping：Ctrl+C 三段优先级、Enter/换行 fallback、菜单优先级、Shell mode、临时视图关闭。
- `InkTimelineProjector`：流式 → 终态、恢复历史、重复 snapshot、Web freeze/return、resize、同 id 只 commit 一次。
- Markdown/tool/diff：有界窗口、unknown fallback、高亮失败纯文本。
- TerminalSizeSource、module path、Node version parser、runtime diagnostics：纯 Adapter 测试。

### 17.2 Renderer 测试

- 静态布局优先使用 Ink `renderToString`。
- 输入集成使用注入的 Node `PassThrough` stdin/stdout 与 Ink render instance；不依赖真实键盘或全局 TTY。
- 测试只断言文本、状态和 intent，不锁定 ANSI 全帧或 Yoga 内部坐标。
- 不建立通用 fake TUI framework；测试穿过 TuiAdapter 和 InputBuffer 的正式 Interface。

### 17.3 Web 与 Runtime 集成

- Node HTTP/WebSocket server 复用当前 route、header、token、重连和恶意帧测试。
- sidecar 测试使用 fixture process/假的 JSON-RPC host，不连接真实模型。
- loopback、进程枚举或真实 TTY 在 sandbox 被禁止时按仓库规则记录环境跳过，不当作实现失败；企业 runner 必须补真实证据。

### 17.4 安装与发布

- shell/PowerShell fixture 覆盖 Node 缺失、Node 19、Node 20/22/24、npm 缺失、企业 registry、PATH、自检和失败不报成功。
- tarball 清单断言含 dist/assets、无 src/tests/Bun/OpenTUI。
- 扫描门禁断言活动源码、manifest、scripts 和 tests 中无 `Bun.`、`bun:`、`bun test`、`bun run`、Bun shebang、OpenTUI import；归档历史文档不参与零引用门禁。

### 17.5 Node 版本矩阵

Node 20、22、24 各执行：

```bash
npm ci
npm run typecheck
npm run build
npm run test:ts
npm run project:check
node packages/cli/dist/bin.js --version
node packages/cli/dist/bin.js --non-interactive --message "fixture"
```

至少一个企业环境真实 TTY 在每个支持 OS family 完成 Ink 启动、提交、取消、Interaction 和退出冒烟。Python 全量测试可在一个主版本执行，但 sidecar spawn/握手必须进入 Node matrix。

## 18. Boundaries

### Always do

- 先迁移测试再删除旧 Runtime 行为，所有行为变化采用 TDD。
- 使用精确依赖版本和单一 package-lock；验证企业 registry 离线安装。
- 保持 TuiAdapter/PresentationServer/GatewayChannel Seam，不让 Renderer 侵入 Core。
- 在所有退出路径恢复终端并回收 sidecar/Web 资源。
- 更新用户文档、依赖清单、架构总览和 TUI 表现层。

### Ask first

- 改变 Node 最低版本、Ink/React 主版本或 npm 主路径。
- 改变 JSON-RPC、Python Agent、SQLite schema、InteractiveIntent 或 Web UI 契约的业务语义。
- 新增支持平台、自动下载 Node、引入 native FFI、开启公网 fallback。
- 放弃 Task 已确认的主屏滚屏或恢复鼠标/常驻 Sidebar。

### Never do

- 保留 Bun/OpenTUI fallback、兼容 wrapper、双 lockfile 或第二个 Renderer。
- 在运行或安装时静默访问公网、下载 native artifact、语言资源或 Runtime。
- 把 API Key、registry 凭据、Web token、Prompt 或工具原文写入日志/错误。
- 为测试暴露 Ink 内部对象到生产 Interface，或用 snapshot 测试锁死 ANSI 帧。
- 因 Node 20 兼容而使用已经不安全的 Node 私有/实验 API。

## 19. 非范围

- 重写 Python Agent、协议、模型、Tool、Plugin、Skill、MCP、Goal、Thread 或持久化语义。
- 自包含 Node/Python Runtime 大包、Homebrew、应用内更新或自动 Node 安装。
- alternate screen、应用内主时间线 ScrollBox、鼠标交互、自动选区复制、常驻 Sidebar、星空背景。
- 通用终端编辑器、输入范围选择、vim/emacs 模式、插件化 Renderer 或可换 TUI 框架。
- Linux musl、Windows ARM、远程终端、浏览器托管 shell。
- Ink/React 主版本升级、Pi TUI 试验或 OpenTUI Node FFI 路线。
- Web 工作台视觉重构；本 Task 只替换 build/server Runtime 并保持现有行为。

## 20. Success Criteria

1. 根 workspace、CLI、工程脚本、测试、安装器和发布包全部以 npm/Node 运行；活动路径无 Bun/OpenTUI。
2. 企业 registry 的干净环境用 `npm ci` 可复现安装，期间无公网请求或下载 fallback。
3. 同一 lockfile、CLI tarball 和 build artifact 在 Node 20、22、24 通过规定矩阵。
4. Ink TUI 完成消息提交、流式输出、Tool、Interaction、取消、Thread 恢复和退出；终端状态正常恢复。
5. 已完成 Timeline 只进入 Static 一次，流式 token 只更新 live 尾部；长对话不反复绘制历史。
6. InputBar 对中文、emoji、组合字符、多行、粘贴、history、Slash、mention 和 Ctrl+C 有自动化证据。
7. 审批、Question、Plan、Goal、pickers、Workspace、Status、BTW 和 Tool details 全部键盘可达。
8. TUI/Web 继续共享唯一 Controller；Web handoff 往返不重复打印历史或丢失期间状态。
9. Node Web server 保持当前 loopback、Host/Origin、token、CSP、单窗口和重连安全测试。
10. Node CLI 在企业策略允许时可靠启动/回收 Python sidecar；策略拒绝时给出准确诊断。
11. 当前支持平台均有安装与运行证据；非范围平台明确拒绝。
12. README、用户文档、开发命令、依赖清单和架构文档只描述新的 canonical 路径。

## 21. Open Questions

没有未决产品或架构问题。实施前使用当前普通 npm registry 记录 npm 10.x、esbuild、tsx、Vitest 与 ws 的精确 patch 版本及 Node 20 engine 事实；企业 registry 可用性由用户迁入后验收，其失败不得通过更换 Runtime、增加运行时公网 fallback 或扩大依赖方案解决。
