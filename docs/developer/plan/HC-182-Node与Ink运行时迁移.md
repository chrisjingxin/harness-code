# HC-182 Node 与 Ink 运行时迁移实施计划

关联：[Task](../task/HC-182-Node与Ink运行时迁移.md) · [Spec](../spec/HC-182-Node与Ink运行时迁移.md) · [Todo](../todo/HC-182-Node与Ink运行时迁移.md)

状态：计划待确认，Task 未认领。本文不新增范围，也不重新选择 Runtime、TUI 框架、测试框架或交互形态。

## 1. Overview

本计划通过五个纵向、可演示的停点完成迁移：

```text
停点 A  npm/Node 启动最小 Ink 对话：输入、流式正文、取消、退出
  ↓
停点 B  Ink TUI 功能闭环：Interaction、菜单、Picker、Tool、临时视图、Workspace
  ↓
停点 C  Node Web Runtime：预构建 assets、loopback server、WebSocket、安全 handoff
  ↓
停点 D  全仓 Bun 清零与 npm 发布包：全部测试、脚本、pack、静态门禁
  ↓
停点 E  企业安装与最终验收：三系统脚本、Node 20/22/24、文档、review
```

一次实现只推进到下一个可演示停点。完成该停点的 Todo、focused tests、演示步骤和 `tmp/handoff.md` 后必须停止，等待用户查看；不得连续做完整份 Todo。

## 2. 依赖图

```text
开发 registry 版本 preflight
  └─ npm workspace + package-lock + Vitest/tsx/esbuild
       ├─ Node entry/path/process/diagnostic
       ├─ InputBuffer
       └─ Ink root + TerminalSize
            └─ Static/live projector + 最小 InputBar/Timeline       → 停点 A
                 ├─ Interaction panels
                 ├─ command/mention/pickers
                 ├─ Markdown/Tool/Diff
                 └─ temporary views/workspace/tool inspector       → 停点 B
                      └─ Web assets + node:http/ws
                           └─ Ink/Web handoff freeze-return         → 停点 C
                                └─ 剩余 tests/scripts/Bun 清零
                                     └─ npm pack                    → 停点 D
                                          └─ install.sh/install.ps1
                                               └─ Node/platform matrix/docs/review → 停点 E
```

可以安全并行但必须协调文件归属的工作：

- A 的 `input-buffer` 与 Node entry/build 可在 npm manifest 固定后并行；前者只改 `tui/input/`，后者只改 composition/toolchain。
- B 的 Interaction panels、Markdown/Tool Renderer、Workspace 临时视图可在 TuiAdapter Interface 固定后并行；不得同时编辑 `app.tsx` 或 `adapter.ts`。
- C 的 Web assets 与 HTTP/WebSocket Adapter 可在 `PresentationServer` Interface 不变的前提下并行。
- D 的测试迁移可按目录分批并行，每批最多约 5 个文件；共享 Vitest config 和测试 setup 由一个 owner 管理。

必须顺序执行：manifest/lock → Node build/entry → Ink root；TuiAdapter Interface → 各 Presentation；Web server → handoff；pack → installer；全部实现 → matrix/review。

## 3. 冻结的架构做法

- Node.js `>=20` 是唯一 Runtime；build target 与 `@types/node` 以 20 为基线。
- Ink 固定 `6.8.0`、React/React DOM 固定 `19.2.6`。
- 根只保留 npm workspace 与 `package-lock.json`；最终删除 Bun/OpenTUI/FFI 路径。
- `InteractiveController` 不改业务语义；TUI 复用并收窄 `TuiAdapter`。
- `InputBuffer` 是纯 reducer；Ink key mapping 不进入 Adapter/Core。
- 历史使用 committed/live 投影：已提交记录只写终端一次，活动尾部才重绘。
- 主时间线不做应用内滚动；鼠标、常驻 Sidebar、自动选区复制和 alternate screen 删除。
- Web server 使用 `node:http` + 直接声明的 `ws`；Coordinator token/lease/revision 语义不改。
- 生产发布物是预编译 JavaScript；tsx/esbuild/Vitest 仅开发依赖。
- 不修改 Python Agent、JSON-RPC、SQLite 或 Web UI 业务/视觉。

## 4. 执行前置

### P1 认领、基线与改动隔离

**Description:** 读取 Task/Spec/Plan/Todo、当前 git 状态和 `tmp/handoff.md`，通过现有任务命令认领 HC-182；记录用户已有改动，不能为迁移清理无关工作树。

**Acceptance criteria:**

- Task 状态为进行中，owner 与 `feat_hc_182_Node与Ink运行时迁移` 分支一致。
- handoff 明确当前停点、已有改动边界、未运行的企业/平台检查。
- 不修改 HC-180 等其它活动 Task 的文件或状态。

**Verification:** V0。  
**Dependencies:** 无。  
**Files likely touched:** Task、生成看板、`tmp/handoff.md`。  
**Estimated scope:** S。

### P2 开发依赖 preflight

**Description:** 对当前普通 npm registry 核验并记录 Spec 要求的 npm 10.9.3、Ink 6.8.0、React 19.2.6、esbuild 0.28.2、tsx 4.23.13、Vitest 4.1.8、ws 8.21.3、string-width 8.2.2 及平台 optional packages；企业 registry 验收由用户迁入后执行。

**Acceptance criteria:**

- 每个直接/关键传递依赖都有当前 registry 版本和 Node engine 证据，写入 dependency versions 的候选变更。
- esbuild、Ink/Yoga、CodeGraph 的目标平台包都由 npm registry 依赖图提供；不存在项目自定义 postinstall 下载。
- 任一必需包缺失时 Task 标阻塞并停止，不私自替换 Runtime/test runner/bundler。

**Verification:** V1。  
**Dependencies:** P1。  
**Files likely touched:** `docs/developer/project/dependency-versions.json`、Task/handoff（阻塞时）。  
**Estimated scope:** S。

## 5. 停点 A：npm/Node 启动最小 Ink 对话

### 用户结果

开发者执行 `npm ci && npm run dev` 进入 Ink 主屏界面，可以输入普通消息、看到流式 assistant 正文、用 Ctrl+C 清草稿/取消 Run/退出。已完成记录进入终端 scrollback；不需要 Bun 启动这一条最小路径。`/web`、复杂 Picker 与工作区浏览暂不作为本停点演示内容。

### A1 npm workspace 与锁文件

**Description:** 把根和 CLI manifests 切到 npm workspace，加入 preflight 已确认的精确依赖与 scripts，生成唯一 lockfile；先保留后续停点尚未迁完的源码，但 canonical 命令只写 npm。

**Acceptance criteria:**

- 根 `packageManager`/engines、CLI dependencies/devDependencies 与 Spec 一致；workspace 内依赖不用 `workspace:*`。
- `package-lock.json` v3 可在临时干净副本执行 `npm ci`，无公网请求；`bun.lock` 最终删除安排在 D，不作为双 lockfile 发布。
- 当前未迁移模块被明确列入 Todo，不能由 scripts 静默回退 Bun。

**Verification:** V2。  
**Dependencies:** P2。  
**Files likely touched:** `package.json`、`packages/cli/package.json`、相邻 workspace manifest、`package-lock.json`。  
**Estimated scope:** M。

### A2 Node 工程脚本与 Vitest 底座

**Description:** 建立 Vitest config/setup 和 `tsx` 工程脚本入口；先迁移 project/protocol 的代表性测试与生成/检查脚本，让 `npm run tasks:check`、`docs:check`、`protocol:check` 能在 Node 上执行。

**Acceptance criteria:**

- 工程脚本用 Node module path，不使用 `import.meta.dir/main` 或 Bun globals。
- Vitest 能运行纯 TS、TSX 与 happy-dom 三类代表性测试，且不会扫描 Python/third_party。
- npm 的 task/docs/protocol 检查与迁移前语义一致。

**Verification:** V3。  
**Dependencies:** A1。  
**Files likely touched:** Vitest config/setup、`scripts/project/index.ts`、一个 project helper、`packages/protocol/scripts/generate.ts`、代表性 tests；分批每次约 5 文件。  
**Estimated scope:** M。

### A3 Node bin、模块路径与诊断

**Description:** 拆分 `bin.ts` 与 `index.ts`，增加 Node >=20 前置门禁和单一 module-path helper，替换 CLI composition root 与诊断中的 Bun runtime 信息；sidecar 仍走现有 `child_process.spawn`。

**Acceptance criteria:**

- Node 19 在加载 Ink 前退出 1；Node 20+ 的 `--version`/`--help` 不启动 sidecar。
- source/dist、空格/中文路径、安装形态 runtime binding 与现有测试语义一致。
- diagnostics 只报告脱敏 `node-<version>`，顶层异常保持稳定格式。

**Verification:** V4。  
**Dependencies:** A1、A2。  
**Files likely touched:** `packages/cli/src/bin.ts`、`src/index.ts`、Node path helper、diagnostic runtime、相邻 tests。  
**Estimated scope:** M。

### A4 esbuild CLI 与 Web asset build

**Description:** 建立 Node/esbuild build scripts，产出 Node 20 ESM CLI、Web app/CSS/worker 与 manifest；当前阶段只要求 assets 可生成，Node Web server 留到 C。

**Acceptance criteria:**

- `npm run build` 输出 shebang 入口和完整 Web asset manifest，不执行 Bun。
- production CLI 不打入 esbuild/tsx/Vitest，internal protocol 可 bundle，Runtime dependencies external。
- 连续两次构建文件清单一致；browser bundle 无 Node builtin 和 secret。

**Verification:** V5。  
**Dependencies:** A1、A3。  
**Files likely touched:** CLI build script、web asset build script、`packages/cli/package.json`、build tests、asset manifest tests。  
**Estimated scope:** M。

### A5 InputBuffer 纯状态机

**Description:** TDD 实现 Spec 第 8 节 InputBuffer reducer、grapheme/cell width、paste normalization 和显示窗口；不接 Ink。

**Acceptance criteria:**

- ASCII、中文、emoji/ZWJ、组合字符、宽字符、CRLF、多行上下移动和删除均不破坏 grapheme。
- 多字符 paste 一次更新、去除控制序列、永不返回 submit effect。
- InputBuffer 不 import React、Ink、TuiAdapter、process 或终端 stream。

**Verification:** V6。  
**Dependencies:** A1。  
**Files likely touched:** `tui/input/input-buffer.ts`、width/paste helper、对应 2～3 个 tests。  
**Estimated scope:** M。

### A6 Ink root、TerminalSize 与唯一关闭路径

**Description:** 用 Ink render 替换 OpenTUI composition root，接入 `exitOnCtrlC=false`、Kitty auto、TerminalSizeSource 和现有 shutdown；先渲染最小 Home/Thread 壳。

**Acceptance criteria:**

- 一个 `runTui` 只创建一个 Adapter/root/handler；close 重复调用仍只 resolve 一次。
- resize 更新动态布局，失败/异常/退出恢复 raw mode 与光标；不发送 mouse/alternate-screen 控制序列。
- WebCoordinator fake 仍可 gate TUI intent；真实 Web server 尚未迁移时 `/web` 给出明确暂不可用，不崩溃。

**Verification:** V7。  
**Dependencies:** A3、A4、A5。  
**Files likely touched:** `tui/app.tsx`、TerminalSize module、error boundary、TUI lifecycle tests、architecture test。  
**Estimated scope:** M。

### A7 committed/live Timeline 最小纵向路径

**Description:** TDD 实现 `InkTimelineProjector`，只先支持 user、assistant、run progress/footer 与恢复历史；建立 StaticTranscript 和 LiveRegion。

**Acceptance criteria:**

- 流式 assistant 只在 live 更新，终态后 commit 一次；重复 snapshot/resize 不重复打印。
- 恢复历史按顺序一次 commit；run progress 永不进入 Static。
- 1000 条已完成 fixture 后追加 token 时，测试证明只更新 live 尾部而非重新产出历史。

**Verification:** V8。  
**Dependencies:** A6。  
**Files likely touched:** timeline projector、Static/Live presentation、timeline tests、long-history test。  
**Estimated scope:** M。

### A8 最小 InputBar 与快捷键闭环

**Description:** 把 Ink `useInput` 标准化为 InputEvent，接入 TuiAdapter draft/submit/history 与 Ctrl+C 三段优先级，渲染最多 6 行的 InputBar；本停点只提供普通输入与最小状态提示。

**Acceptance criteria:**

- Enter 提交；Shift+Enter 与 Alt+Enter/Ctrl+J fallback 换行；paste 不提交。
- draft 非空 Ctrl+C 清空，之后取消 active Run，再之后退出；Esc 不取消 Run。
- 提交 accepted 后清空并记历史；rejected 保留 draft 并显示原因。

**Verification:** V9。  
**Dependencies:** A5、A6、A7。  
**Files likely touched:** input key mapping、`presentation/input-bar.tsx`、最小 BottomArea、shortcut tests、input integration test。  
**Estimated scope:** M。

### 可演示停点 A：最小 Ink 对话

执行 V0～V9。用户查看：

```bash
npm ci
npm run dev
```

1. 在 Ink 界面发送一条不触发 Tool 的消息，观察 user 记录进入终端 scrollback、assistant 流式尾部更新并在结束后固定。
2. 输入中试粘贴多行、Shift+Enter/fallback 换行；Ctrl+C 依次验证清草稿、取消 Run、退出。
3. 退出后终端输入、光标和回显正常。

更新 Todo 与 `tmp/handoff.md`，记录仍未交付的 Interaction/Web/全仓清零，**停止等待用户查看**。

## 6. 停点 B：Ink TUI 功能闭环

### 用户结果

TUI 已能完成日常 Coding Agent 工作：审批/问答/Plan/Goal、Slash/mention、模型/Thread/Skill/Agent/Undo、Tool/Diff、状态/BTW/Inspect、Workspace/File preview 和 Tool Inspector 全部键盘可达。OpenTUI Renderer、鼠标 Sidebar 和自动选区复制退出活动代码路径。

### B1 收窄 TuiAdapter Interface 与快捷键 owner

**Description:** 删除 renderer ref、scrollRequest、hover/mouse/sidebar layout/selection-copy 状态，把 Workspace/Tool detail 改为语义临时视图；固定 key owner 优先级。

**Acceptance criteria:**

- snapshot/intent 不 import Ink/OpenTUI 或按键对象；conversation 不再有滚动 intent。
- 相同按键只被最高优先级 owner 处理，低层不收到重复 Enter/Esc/Ctrl+C。
- Web Adapter/Core Interface 无业务语义变化。

**Verification:** V10。  
**Dependencies:** A8。  
**Files likely touched:** `tui/application/adapter.ts`、`application/shortcuts.ts`、presentation types、adapter tests、architecture test。  
**Estimated scope:** M。

### B2 Interaction BottomArea

**Description:** 迁移 approval、directory trust、question、plan、goal 到 Ink 内联 Panel，并复用现有 `bottomAreaKind` 与 shared interaction policy。

**Acceptance criteria:**

- pending Interaction 与 InputBar 严格互斥；决定 accepted/rejected 的 draft/错误行为与现有 Core 一致。
- 文件 diff、Plan 编辑、Question 多选/other、Goal review 键盘可完成。
- Presentation 失败不吞 Interaction，不新增协议字段或授权选项。

**Verification:** V11。  
**Dependencies:** B1。  
**Files likely touched:** BottomArea、Interaction panels（分两批）、shared view adapter、focused tests。  
**Estimated scope:** M；每个实现批次不超过约 5 文件。

### B3 Command、mention 与 Picker

**Description:** 迁移 command/mention menu、model/thread/skill/agent/undo picker 和确认 dialog 为 BottomArea 上方的内联列表；删除绝对定位和 mouse hover。

**Acceptance criteria:**

- ↑↓/Ctrl+P/N、Enter/Tab、Esc 与分页/目录进退符合 Spec 优先级。
- 无候选时 Enter/Tab 不误提交；Slash unknown/escaped 和 `@` 路径语义不变。
- loading/empty/error/disabled 原因可见，内部 ID/endpoint/凭据不展示。

**Verification:** V12。  
**Dependencies:** B1。  
**Files likely touched:** command menu、mention menu、pickers/dialog、Adapter intent mapping、focused tests；按菜单族分批。  
**Estimated scope:** M。

### B4 Markdown、Reasoning、Tool 与 Diff

**Description:** 使用 marked + 已初始化的离线 Shiki 映射 Ink Text/Box；迁移 reasoning、tool registry/renderers、diff 与 paint budget，并扩展 projector 的 commit 条件。

**Acceptance criteria:**

- assistant Markdown、代码、列表、表格保持可读；高亮初始化/语言失败固定降级纯文本且无网络。
- reasoning/tool 在活动时 live、终态后只 commit 一次；unknown Tool 使用 generic。
- Tool、reasoning、diff 都执行现有有界绘制，授权不依赖高亮成功。

**Verification:** V13。  
**Dependencies:** A7、B1。  
**Files likely touched:** Markdown module、timeline、tool registry/renderers、projector、focused tests；按 renderer 类型分批。  
**Estimated scope:** M。

### B5 状态、BTW 与 Inspect 临时视图

**Description:** 把 `/status`、`/btw`、Plan/Goal/Inspect 等现有 overlay 投影为全宽 TemporaryView，使用有界分页而非 ScrollBox。

**Acceptance criteria:**

- Esc/Enter/q 与 PgUp/PgDn/Home/End 行为固定；关闭后回到先前 BottomArea。
- `/btw c` 仍走显式 clipboard Adapter，失败可见；不恢复鼠标自动复制。
- 长内容只更新当前页，关闭视图不重印 committed Timeline。

**Verification:** V14。  
**Dependencies:** B1、B4。  
**Files likely touched:** temporary-view shell、status、btw/inspect、pagination helper、focused tests。  
**Estimated scope:** M。

### B6 Workspace 与 Tool Inspector

**Description:** 用 `Ctrl+B` 打开 Workspace 全宽浏览，用 `Ctrl+O` 打开 Tool Inspector；复用 WorkspaceExplorer 和 Timeline view model，删除 Sidebar/dock/鼠标布局。

**Acceptance criteria:**

- Workspace 支持键盘展开、选择、预览、`@` 插入与 Esc 返回；大文件/二进制继续安全提示。
- Tool Inspector 可选择最近 Tool 并看有界详情，不改 Transcript、不执行 Tool。
- 已 committed Tool 摘要不因 Inspector 打开/关闭重写。

**Verification:** V15。  
**Dependencies:** B1、B4、B5。  
**Files likely touched:** workspace temporary view、file preview、tool inspector、Adapter state、focused tests。  
**Estimated scope:** M。

### B7 完整快捷键、Shell mode、Toast 与窄终端

**Description:** 收口 Shell mode、work/approval mode、child timeline、Toast、TerminalSize 断点和非 enhanced keyboard fallback；删除 selection-copy、mouse 与 conversation scroll。

**Acceptance criteria:**

- Spec 键位表和 owner 优先级逐项有测试；Shell `!`、history、child timeline、Toast 不回归。
- 40/72/120 列 fixture 可读，不出现负宽度/无限换行；resize 不重印 Static。
- 源码无 mouse event、OpenTUI selection、主时间线 scroll ref。

**Verification:** V16。  
**Dependencies:** B2～B6。  
**Files likely touched:** shortcuts/key mapping、status line/layout、Toast/child view、selection/scroll 删除、focused tests。  
**Estimated scope:** M。

### B8 OpenTUI Presentation 清理与 TUI 回归

**Description:** 删除已替换的 OpenTUI JSX、Tree-sitter Renderer 注册、starry/sidebar/overlay/selection legacy 文件和对应过时测试；更新 TUI architecture test，只保留 Ink canonical imports。

**Acceptance criteria:**

- `packages/cli/src/tui` 无 `@opentui/*`、`bun:ffi`、OpenTUI intrinsic tags/ref。
- 没有未使用 legacy Renderer、兼容 alias 或双组件树；仍有价值的纯 helper 移到正确 Module。
- TUI focused suite 覆盖恢复、长会话、Interaction、菜单、Workspace、错误/退出。

**Verification:** V17。  
**Dependencies:** B2～B7。  
**Files likely touched:** legacy 文件删除集合、TUI architecture tests、package manifest；删除按职责批次执行。  
**Estimated scope:** M（大量删除，新增/改写保持小批次）。

### 可演示停点 B：完整 Ink TUI

执行 V10～V17 并复跑 V6～V9。用户查看：

1. 发起一次含 Tool 和审批的 Run，完成 Allow/Reject、Question、Plan/Goal。
2. 输入 `/`、`@`、`/resume`、`/model`，检查键盘选择；打开 `/status`、`/btw`。
3. Ctrl+B 浏览/预览文件并插入引用；Ctrl+O 查看 Tool；终端原生拖选复制历史。
4. 恢复长 Thread，缩放终端，确认历史不重复打印、活动尾部仍流式更新。

更新 Todo 与 handoff，**停止等待用户查看**；此时 `/web` 仍未完成 Node server 验收。

## 7. 停点 C：Node Web Runtime 与 handoff

### 用户结果

在 Node/Ink TUI 输入 `/web` 可打开现有 Web 工作台。浏览器接管期间终端只显示接管提示，不同步刷 token；返回后补齐期间记录且不重复历史。Host/Origin/token/CSP/单窗口与重连安全行为不退化。

### C1 运行时只读 Web assets

**Description:** 删除 `browserBundle()` 的 source/Bun build fallback，只读取构建 manifest；完善 esbuild CSS/worker 资产测试与缺失错误。

**Acceptance criteria:**

- 生产和 dev 都在启动前生成 assets；运行时不 import esbuild。
- manifest 拒绝绝对路径、`..`、缺失/额外错误形状。
- asset 缺失只让 `/web` 失败，TUI 继续可用。

**Verification:** V18。  
**Dependencies:** A4。  
**Files likely touched:** `web/bundle.ts`、asset build script、bundle tests、manifest tests。  
**Estimated scope:** S。

### C2 Node HTTP 静态路由

**Description:** 用 `node:http` 实现 PresentationServer 的 loopback bind、路由白名单、Host/method/header/CSP 和幂等 stop，暂不接 WebSocket message。

**Acceptance criteria:**

- 只监听 127.0.0.1:0；错误 Host/path/method/upgrade 返回现有状态码。
- 静态响应 header 与当前安全策略一致，不按请求路径读文件。
- bind 禁止/stop 竞态不会退出整个 TUI 或挂住 shutdown。

**Verification:** V19。  
**Dependencies:** C1、A3。  
**Files likely touched:** `web/server.ts`、HTTP adapter helper、server route tests、shutdown test。  
**Estimated scope:** M。

### C3 `ws` GatewayChannel Adapter

**Description:** 在 HTTP upgrade 上接 `ws.WebSocketServer({noServer:true})`，保留 token 验证、AsyncQueue、maxPayload、binary/invalid frame 和 channel close 语义。

**Acceptance criteria:**

- Origin/token/handoff 验证在 upgrade 前；失败不消费 token。
- 禁用 compression；二进制、超限、畸形帧进入 invalid-message；URL token 不进日志。
- channel `isOpen/send/close/messages` 满足 Coordinator/Gateway tests，stop 关闭活跃连接。

**Verification:** V20。  
**Dependencies:** C2。  
**Files likely touched:** `web/server.ts`、WebSocket Adapter helper、server/integration tests、types。  
**Estimated scope:** M。

### C4 Ink/Web freeze-return

**Description:** 保持同一 Ink root/TuiAdapter/TimelineProjector，按 Coordinator phase 冻结终端输出并在返回时补一次 committed/live delta；复用输入租约。

**Acceptance criteria:**

- web-active 不向终端刷 Browser 期间 token；TUI intent 被租约拒绝。
- return 后新增历史按顺序只打印一次，draft/picker/当前 Thread 保留。
- ready timeout、刷新宽限、第二窗口、退出与畸形帧都回到正确状态或关闭。

**Verification:** V21。  
**Dependencies:** B8、C3。  
**Files likely touched:** Ink root/web-takeover view、TimelineProjector phase handling、handoff tests、takeover recovery tests。  
**Estimated scope:** M。

### 可演示停点 C：Web 往返

执行 V18～V21。用户查看：

1. `npm run dev` 后输入 `/web`，浏览器打开既有工作台。
2. Browser 发消息并等待完成，终端期间不滚动刷 token。
3. 返回 TUI，期间消息只补一次，draft/Thread/状态继续；再试刷新重连与第二窗口拒绝。

更新 Todo 与 handoff，**停止等待用户查看**。

## 8. 停点 D：全仓 Bun 清零与 npm 发布包

### 用户结果

开发者只用 npm 即可安装依赖、生成协议、运行全部 TS/Python 测试、构建和打包。CLI tarball 在临时 prefix 安装后可执行 `harness --version` 和 fixture 无头握手。活动源码、测试、脚本、manifest 与 lockfile 没有 Bun/OpenTUI。

### D1 剩余测试按目录迁移

**Description:** 将尚未随 A～C 迁移的 `bun:test`、Bun mock/timer/file/process 用法按目录转换为 Vitest/Node；每批最多约 5 文件并立即运行 focused tests。

**Acceptance criteria:**

- project、protocol、interactive、ipc、infrastructure、web、acceptance 每个目录均由 Vitest 收集并通过。
- 不建立 Bun compatibility shim，不静默 skip 原有行为测试。
- loopback/宿主权限 skip 只按仓库既有规则记录，普通失败必须修复。

**Verification:** V22。  
**Dependencies:** B8、C4。  
**Files likely touched:** 各 tests 目录，按清单小批次；共享 config 只有一个 owner。  
**Estimated scope:** M × 多批机械迁移。

### D2 工程/资源/集成脚本 Node 化

**Description:** 替换剩余 `Bun.write/file/spawn/spawnSync`、`import.meta.dir/main`、`bunx`，迁移 syntax/vendor、pack 和 integration harness；不能从公网补资源。

**Acceptance criteria:**

- 所有活动脚本由 npm/tsx/node 执行；下载型 syntax vendoring 不属于普通 build/install，且只能显式使用批准源。
- integration tests 启动编译后的 Node CLI，不直接用 Bun 执行 TS。
- task/version/release/protocol 命令行为与迁移前一致。

**Verification:** V23。  
**Dependencies:** D1、A4。  
**Files likely touched:** `packages/cli/scripts/*`、`scripts/project/*`、protocol scripts、integration tests；按 5 文件批次。  
**Estimated scope:** M × 多批。

### D3 静态清零门禁与依赖删除

**Description:** 删除 Bun/OpenTUI dependencies、types、lockfile、native/FFI/legacy assets，增加 active-path scan；更新 npm lock 和 dependency versions。

**Acceptance criteria:**

- active source/tests/scripts/manifests 无 `Bun.*`、`bun:*`、Bun shebang、`bun run/test/x`、`@opentui/*`。
- 根只剩 `package-lock.json`；npm ls 无 extraneous/invalid，生产依赖无 Bun/OpenTUI/native FFI。
- 归档历史文档允许保留事实性旧命令，活动开发文档在 E 更新。

**Verification:** V24。  
**Dependencies:** B8、D1、D2。  
**Files likely touched:** manifests/locks、dependency versions、scan test、legacy 删除集合。  
**Estimated scope:** M（以删除为主）。

### D4 npm publishable package

**Description:** 改造 pack-publishable 流程，生成非 private 的发布副本并用 `npm pack --workspace @za38/cli` 验证文件和依赖；在临时 prefix 安装 tarball。

**Acceptance criteria:**

- tarball 含 Node bin、web assets、离线 Runtime assets，不含 src/tests/build tools/凭据。
- 临时 prefix 的 `harness --version` 不启动 sidecar；fixture sidecar 能完成无头握手。
- tarball 安装不访问非企业 registry，不运行项目自定义联网 postinstall。

**Verification:** V25。  
**Dependencies:** D3。  
**Files likely touched:** pack script、CLI publish manifest/template、pack tests、runtime binding test。  
**Estimated scope:** M。

### 可演示停点 D：npm build/test/pack

执行 V22～V25，并运行完整 `npm test`、`npm run build`、`npm run project:check`。用户查看：

```bash
npm ci
npm run typecheck
npm run build
npm test
npm pack --workspace @za38/cli
```

在临时 prefix 安装 tarball，执行 `harness --version` 与 fixture 无头命令；展示 active-path scan 为零。更新 Todo/handoff，**停止等待用户查看**。

## 9. 停点 E：企业安装、矩阵与最终验收

### 用户结果

macOS/Linux/Windows x64 安装器检测企业已有 Node >=20，使用 npm 安装 CLI、uv 安装 Agent；Node 缺失/过低时给出企业渠道提示而不访问公网。Node 20/22/24 使用同一 tarball 完成安装、TUI/无头/sidecar 冒烟。文档只描述 npm/Node/Ink canonical 路径。

### E1 Unix 安装器

**Description:** 将 `install.sh` 的 Bun 检测/下载/全局 bin 改成 Node/npm 版本门禁与 npm global prefix；保留 uv/Python、企业源、配置保护和自检。

**Acceptance criteria:**

- Node 缺失/19 退出 1 并指向企业渠道；Node 20/22/24 + npm>=10 跳过 Runtime 安装。
- 使用 `npm install -g`；不访问公网、不覆盖配置、不写密钥；自检失败不报成功。
- macOS/Linux 支持矩阵和 `--help`/未知参数/`--no-modify-path` 语义有 fixture。

**Verification:** V26。  
**Dependencies:** D4。  
**Files likely touched:** `scripts/install/install.sh`、Unix fixture tests、install docs snippet。  
**Estimated scope:** M。

### E2 Windows PowerShell 安装器

**Description:** 将 `install.ps1` 同步为 Node/npm 语义，处理 Windows npm global prefix、PowerShell 宿主、用户 PATH 和 `harness-agent.exe`。

**Acceptance criteria:**

- 与 Unix 相同版本/失败语义；CMD/Git Bash 误用、Windows ARM、Node 过低明确拒绝。
- 用户 PATH 只写 npm global 与 uv tool bin，不写 Bun bin。
- Windows fixture/runner 验证重复安装、已有配置、自检与退出码。

**Verification:** V27。  
**Dependencies:** D4、E1（共享语义先固定）。  
**Files likely touched:** `scripts/install/install.ps1`、PowerShell fixture tests、Windows runtime binding test。  
**Estimated scope:** M。

### E3 Node 20/22/24 与平台矩阵

**Description:** 用同一 commit、lockfile、tarball 执行 Spec 第 17.5 节矩阵；在可用企业 runner 完成真实 TTY/sidecar/Web smoke，记录无法在 sandbox 执行的宿主证据。

**Acceptance criteria:**

- 三个 Node 主版本完成 npm ci/typecheck/build/TS tests/project check/version/headless handshake。
- macOS、Linux glibc、Windows x64 至少各有安装和 sidecar 证据；真实 TTY 验证输入、Interaction、退出。
- musl/Windows ARM 只验证拒绝，不冒充支持；所有跳过有原因和补证责任。

**Verification:** V28。  
**Dependencies:** E1、E2。  
**Files likely touched:** CI/matrix 配置（若仓库已有）、Task evidence、测试 fixture；不为本 Task新建发布平台。  
**Estimated scope:** M。

### E4 用户与开发者文档

**Description:** 更新 README、快速开始、交互使用、故障排查、开发工作流、依赖清单、架构总览和 TUI 表现层，移除活动文档中的 Bun/OpenTUI 主路径和旧鼠标/Sidebar说明。

**Acceptance criteria:**

- 用户能按文档完成 npm 安装/卸载、源码开发、InputBar 键位、Workspace/Tool Inspector、Web handoff 和常见失败处理。
- 架构只描述 Node/npm/Ink committed/live canonical 路径；HC-145/181 保留历史链接。
- 文档不承诺 Node 20 仍受官方安全维护，不暴露企业凭据或占位公网入口。

**Verification:** V29。  
**Dependencies:** E3。  
**Files likely touched:** Task 指定 user docs、开发工作流、dependency versions、两份 architecture；按用户/开发者两批。  
**Estimated scope:** M。

### E5 完整验证、review、归档准备

**Description:** 运行完整检查，使用 `code-review-and-quality` 对照 Task/Spec 审查 diff、测试、终端安全、Web 安全、数据/协议不变和文档；修复问题并记录版本影响。

**Acceptance criteria:**

- `npm run project:check`、typecheck、build、TS/Python tests 与适用 E2E 全绿；review 无未解决 P0/P1。
- Task 写入精确测试/平台/跳过证据；Todo 全部实现项已勾选，版本影响明确。
- 用户验收前不自动发布、提交、改版本或归档；归档仅在用户明确确认后执行。

**Verification:** V30。  
**Dependencies:** E4。  
**Files likely touched:** Task/Todo/handoff、review 修复涉及文件。  
**Estimated scope:** M。

### 可演示停点 E：最终验收

展示安装、三 Node 版本、三 OS family、完整 Ink TUI、Web handoff、零 Bun scan、文档入口和 review 结果。更新 Task/Todo/handoff，**停止等待用户最终验收**。只有用户明确验收后才运行 task completion、移动 Task 到 archive、同步看板和处理版本发布。

## 10. 验证命令索引

实现时先跑 focused，再在停点运行组合检查。以下命令是迁移后的目标命令；A1/A2 尚未落地前只使用当前仓库已有命令建立基线。

| ID | 命令/证据 |
| --- | --- |
| V0 | `git status --short`；Task claim；handoff 边界 |
| V1 | 当前 registry `npm view`；Node engines、platform packages、install script 记录；企业源验收延后 |
| V2 | 临时干净副本 `npm ci`；`npm ls --all`；lockfile diff |
| V3 | `npm run tasks:check && npm run docs:check && npm run protocol:check`；代表性 Vitest |
| V4 | `npm run test:ts -- --run packages/cli/tests/args.test.ts packages/cli/tests/index.test.ts packages/cli/tests/runtime-binding.test.ts packages/cli/tests/diagnostics` |
| V5 | `npm run build`；build/asset manifest tests；dist file list diff |
| V6 | InputBuffer focused tests |
| V7 | TUI lifecycle、TerminalSize、error/close focused tests |
| V8 | TimelineProjector、恢复、重复 snapshot、1000-entry focused tests |
| V9 | InputBar/key mapping/submit/cancel/paste integration tests |
| V10 | TuiAdapter/shortcut/architecture tests |
| V11 | BottomArea + approval/question/plan/goal focused tests |
| V12 | command/mention/picker/dialog focused tests |
| V13 | Markdown/reasoning/tool/diff/projector tests |
| V14 | status/BTW/inspect/temporary pagination tests |
| V15 | workspace/file preview/tool inspector tests |
| V16 | shortcut/shell/resize/toast/child timeline tests |
| V17 | `npm run test:ts -- --run packages/cli/tests/tui`；TUI OpenTUI scan |
| V18 | Web bundle/manifest/syntax worker tests |
| V19 | HTTP route/header/host/bind/stop tests |
| V20 | WebSocket token/frame/channel/server integration tests |
| V21 | web handoff/takeover recovery + Ink projector freeze-return tests |
| V22 | 每批 Vitest focused；最终 `npm run test:ts` |
| V23 | project/protocol/resource/integration script focused tests |
| V24 | active-path `rg` gate；`npm ls --all`；lockfile/manifest tests |
| V25 | `npm pack --workspace @za38/cli`；临时 prefix install/version/headless fixture |
| V26 | Unix installer fixtures；支持平台真实 shell smoke |
| V27 | PowerShell fixtures；Windows x64 runner smoke |
| V28 | Node 20/22/24 matrix + macOS/Linux/Windows 证据 |
| V29 | `npm run docs:check && npm run tasks:check`；按用户文档走查 |
| V30 | `npm run project:check && npm run typecheck && npm run build && npm test && npm run test:web:e2e`；review |

Python focused/全量命令继续为：

```bash
cd packages/agent && .venv/bin/python -m pytest -q <focused paths>
cd packages/agent && .venv/bin/python -m pytest -q
```

真实 loopback、TTY、PowerShell 或平台 runner 因 sandbox 权限无法执行时，按仓库规则记录环境跳过；不要把权限失败当代码缺陷，也不要未经用户要求申请额外宿主权限。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 企业源缺 esbuild/tsx/Vitest/Ink transitive 平台包 | 无法离线迁移 | P2 fail-fast，缺包即阻塞；不公网自愈或换 Runtime |
| Ink 没有 textarea/scrollbox | 输入或长会话不可用 | A5/A7 提前验证 InputBuffer 与 Static/live，未通过不进入 UI 扩展 |
| Static 记录无法展开 | 历史 Tool 详情丢失 | committed 摘要固定，Ctrl+O Tool Inspector 从 snapshot 展示详情 |
| Web handoff 造成历史重复打印 | scrollback 污染 | 保持同一 projector；web-active freeze，return delta 测试 |
| Vitest 大规模迁移掩盖测试语义 | 假绿/遗漏 | 按目录和 5 文件批次迁移，禁 shim，逐批 focused + 最终 collection 数核对 |
| Node HTTP/ws 与 Bun upgrade 行为不同 | Web 安全/重连回归 | 保持 PresentationServer/GatewayChannel Seam，复用攻击与竞态测试 |
| Node 20 已 EOL | 安全风险 | 仅作最低兼容；生产建议 22/24，文档明确，类型/build 不越过 20 |
| 企业限制并非 Bun 而是所有 child process/loopback | Node 后仍不能用 | E3 在目标环境分别验证 sidecar 与 loopback；准确诊断而非隐藏 |
| Windows raw input/Shift+Enter 差异 | 无法换行或退出 | Kitty auto + Alt+Enter/Ctrl+J fallback；Windows runner/真实 TTY 证据 |
| 并行修改 app/adapter/config 冲突 | 集成返工 | 共享 Interface/配置先落地，文件 owner 独占；停点集成由 root owner 完成 |

## 12. 冻结的非范围

- 不改 Python Agent、JSON-RPC、SQLite、模型、Tool、Plugin、Skill、MCP、Goal 或 Thread 业务语义。
- 不保留 Bun/OpenTUI fallback、双 lockfile、第二 Renderer 或兼容 alias。
- 不做 alternate screen、主时间线 ScrollBox、鼠标/自动选区复制、常驻 Sidebar、星空背景。
- 不做通用终端编辑器、输入选择、vim/emacs 模式或插件化 Renderer。
- 不自动下载 Node，不打自包含 Runtime，不新增 Homebrew/自更新。
- 不支持 Linux musl、Windows ARM、远程/浏览器托管终端。
- 不升级 Ink/React 主版本，不引入 Pi TUI，不重做 Web 视觉。
- 执行中发现需要改变公开行为、依赖角色、生命周期或安全语义时，先修订 Task/Spec/Plan，不能在 Todo 内临时决定。
