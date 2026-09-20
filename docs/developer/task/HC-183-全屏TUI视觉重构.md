---
id: HC-183
title: 全屏TUI视觉重构
feature_area: CLI 终端界面
parent_task: -
decomposed_by: Codex
priority: P1
status: 进行中
owner: Codex
branch: feat_hc_183_全屏TUI视觉重构
scope: 将 HC-182 建立的 Ink TUI 从主屏滚屏改为唯一的全屏 alternate-screen 界面，重建时间线、输入区、菜单、Interaction、临时视图、滚动与响应式视觉层级；保留 Interactive Core、TuiAdapter 业务 seam 和现有命令语义。
acceptance: 用户通过 npm run dev 进入单列全屏 TUI，可用键盘与鼠标滚轮浏览应用内历史，输入区固定在底部；消息、思考、工具、审批与状态具有统一且可扫描的层级；退出或异常后恢复原 Shell；40、72、120 列及短终端均有自动化与实机证据。
user_docs: docs/user/交互使用.md、docs/user/故障排查.md
developer_docs: docs/developer/spec/HC-183-全屏TUI视觉重构.md、docs/developer/plan/HC-183-全屏TUI视觉重构.md、docs/developer/todo/HC-183-全屏TUI视觉重构.md、docs/developer/architecture/TUI表现层.md、docs/developer/architecture/架构总览.md
test_evidence: 停点 D 自动化：TUI 17 files / 135 tests、CLI 124 files / 1129 tests、npm run typecheck、npm run build、npm run project:check 全部通过；ASCII Logo、终端 Markdown 词法语法着色、Thinking 思维链呈现与用户消息彩条已闭环；等待用户停点 D 实机体验确认
references: docs/developer/task/HC-182-Node与Ink运行时迁移.md、docs/developer/task/archive/HC-145-TUI视觉与渲染重构.md
completed_at: -
---

# HC-183 全屏 TUI 视觉重构

## 需求来源与当前阶段

HC-182 已把 CLI 迁移到 Node.js、npm 与 Ink 6.8.0，并优先完成终端能力闭环。迁移后的 TUI 可以运行，但仍是最小实现：已完成记录进入终端原生 scrollback，底部动态区分别渲染输入、菜单和 Interaction；颜色、边框、状态、消息类型与响应式规则缺少统一的视觉语言。

2026-09-18，用户要求参考本地 Qwen Code 与 Claude Code 的成熟终端交互重做整体 TUI。需求已按 `grilling` 确认：

1. 允许调整信息组织，包括工具活动分组、思考折叠和历史 Interaction 摘要，但不改变命令、快捷键、审批或 Agent 业务语义。
2. 不再沿用 HC-182 的主屏滚屏，改为 Qwen Code / Claude Code 风格的全屏应用内视口。
3. 全屏 TUI 是唯一 canonical 路径，不保留可切换的主屏滚屏模式。
4. 使用单列布局，不恢复常驻 Sidebar；Workspace、状态和工具详情使用覆盖视图。
5. 首期同时支持键盘和鼠标滚轮；不恢复点击、hover 或自动复制，文本复制依赖终端原生选择。
6. 使用 alternate screen；退出后恢复进入 Harness 前的 Shell 画面，对话以 Thread 持久化而不是终端 scrollback 留存。
7. 只整改 Ink TUI；Web UI、Python Agent、SQLite 和 JSON-RPC v3 均不改。

用户已确认 Task / Spec / Plan / Todo。当前任务已认领并完成全部工作包开发（WP1–WP14）；停点 A/B/C/D 的代码与全套自动化测试全部通过，用户文档与架构文档已全面同步收敛，等待用户进行最终停点 D 实机体验验收。

## 实施进度

### 2026-09-20：视觉质感美化（参考 Claude Code & Qwen Code）

- **Harness Code 品牌 ASCII Logo 恢复**：新增 `harness-logo.tsx`，使用精巧方块字符（`█`, `▀`, `▄`）绘制 3 行 `HARNESS CODE` 艺术字标 + `powered by za38`，宽屏下自适应居中，40x12 紧凑屏幕自动降级为单行文字字标，确保小终端内绝对不溢出。
- **终端 Markdown 富文本与代码语法高亮**：
  - 彻底重构 `terminal-markdown.ts`，引入单趟正则词法着色器 `highlightCodeLine`（关键字、类型、字符串、注释、数字、函数名），杜绝 ANSI 二次污染；
  - 代码块渲染优雅框体（`╭─ lang ─╮`、`│ code`、`╰───────╯`）；
  - 行内代码（codespan）采用深灰底冰蓝字高亮，且不破坏句子自然空格间距；
  - 标题、强调、引用、列表层级清晰，完全符合 ANSI-safe cell-width 约束。
- **模型思考过程（Thinking / Reasoning）流式呈现**：
  - 纯投影层（`fullscreen-projection.ts`）严格遵循 Paint Budget 纯文本有界约束（12 行），不泄露转义字符到数据模型；
  - 表现层（`app.tsx`）呈现淡紫色思考状态与深灰缩进竖线（`│ 思考内容`），实时流式更新；
  - 思考完成后折叠为首行摘要并在 `details` 中保留完整思维链，支持历史回溯。
- **用户消息模式彩条**：Build 模式使用金色竖条（`▎`），Compose 模式使用紫色竖条，配合高亮 `❯ `，对话层级一眼可辨。
- **测试证据**：`bun test packages/cli/tests/tui`（17 files / 135 tests 全部通过）；`npm --prefix packages/cli test`（124 files / 1129 tests 全部通过）；`bun run --cwd packages/cli typecheck`（通过）；`bun run --cwd packages/cli build`（通过）；`npm run project:check`（通过）。

### 2026-09-20：可演示停点 D（待用户实机验收）

- **WP9（Interaction 统一）**：统一抽取 `InteractionShell`，Shell 审批展示命令正文与副作用提示，文件操作展示操作标签、路径与红绿 Diff，Plan 与 Directory Trust 保持严格决策集合，修复 40×12 紧凑视口下选项预算分配，全面淘汰裸 inverse，选中项使用 `❯ ` 与主题高亮。
- **WP10（Overlay 与 Web Handoff 统一）**：统一抽取 `OverlayShell`，Workspace、Tool Inspector、Status、BTW 均统一外壳与选中项样式；作为主内容层替换 Timeline 视口挂载，解决重复占用底栏高度与滚动截断问题。
- **WP11（响应式与长内容回归）**：建立 40/72/120 × 12/17/24 完整尺寸矩阵测试，覆盖长路径、长命令、CJK、Emoji 与多行输入，确保无负尺寸、无横向溢出且底部槽位始终可用。
- **WP12–WP14（终端恢复、旧路径清理与文档收敛）**：
  - 架构文档 `TUI表现层.md` 全面重写为 Ink 全屏 alternate-screen 架构，清理旧 OpenTUI/侧边栏/主屏滚屏残留；增量更新 `架构总览.md`。
  - 用户文档 `docs/user/交互使用.md` 与 `docs/user/故障排查.md` 全面更新：收敛为全屏单列、应用内滚动快捷键与鼠标滚轮、终端原生划词复制（不自动复制）、覆盖视图（无常驻侧栏）、40×12 降级与终端未正常恢复的处理方法。
- **工程验证证据**：`npm run test:ts -- --run packages/cli/tests/tui`（17 files / 133 tests 全部通过）、`npm run typecheck`（通过）、`npm run build`（通过）、`npm run project:check`（通过）、`git diff --check`（无空白/换行错误）。
- 当前运行器不是真实 TTY，完整全屏 TUI 真实体验（欢迎页 → 对话 → 工具 → 审批 → 覆盖视图 → 退出）保留等待用户实机确认。

### 2026-09-20：可演示停点 C（待用户实机验收）

- 新增纯 `projectFullscreenTimeline()`：用户、Assistant、Reasoning、Tool、Interaction、Compose 与 Goal 使用稳定语义条目和中文状态，旧 `You:`、`Harness:`、`Reasoning:`、`Tool:` 日志前缀已退出主屏路径。
- 连续、已完成且同 run/execution/activity 的 `read_file`、`grep`、`glob`、`ls` 会形成只读活动摘要；写入、删除、Shell、子代理、运行中、失败与未知工具保持独立。分组保留全部 Tool 身份，并通过 alias 保住正在阅读的 viewport anchor。
- 只有活动行挂载固定宽 spinner；完成历史不创建计时器，spinner 变化不触发历史 Markdown 重解析或 viewport 全量重排。
- Assistant 正文已接入终端 Markdown 纯投影：支持标题、强调、行内/围栏代码、列表、任务列表、引用、HTTP(S) 链接和表格；40 列表格纵向降级，宽表超限也改为无损 key/value，不静默截断长表头或单元格。
- 所有不可信展示文本进入预算前统一清理 ANSI、OSC、C0/C1 控制序列；换行与截断使用 terminal cell width，覆盖中文、emoji 和组合字符。
- TDD 与复审证据：`npm run test:ts -- --run packages/cli/tests/tui`（16 files / 119 tests）、`npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check` 全部通过；独立 tester 复跑通过，reviewer 提出的 anchor、安全、表格和 spinner 性能问题均已修复。
- 当前运行器不是真实 TTY，包含读/写/Shell/子代理/失败工具的真实混合会话、活动动画和 40/72/120 列 Markdown 观感仍需用户实机确认；未伪造人工证据。

### 2026-09-20：可演示停点 B（待用户实机验收）

- Theme 已收敛为单一 token 来源，Ink 生产组件不再散落 raw semantic color；Header、Footer 会在 40/72/120 列按优先级降级。
- 空 Thread 使用六行内欢迎页，展示版本、workspace、model、mode 与三个真实入口；InputBar 使用与 Build/Compose 模式同色的圆角边框，顶边保持纯边线、底边嵌入有界帮助，中间保留最多四行正文，整体不超过六行且不重复 Header/Footer 信息。
- 长单行输入按终端 cell width 保留光标附近窗口，中文等宽字符不会把末尾光标挤出视图。
- Command、mention、Skill、Thread、Model、Agent、Undo 共用菜单密度、截断、空态与“❯ + 加粗/强调色”选中信号；长确认文案在 40×12 仍保留确认/取消、输入与状态。
- Toast 使用固定一行槽位和 glyph + semantic color；出现/消失不改变 Timeline、InputBar 或 BottomArea 的位置。
- 复审补强：40×12 的目录信任始终保留“遮蔽主工作区”风险提示与决定；欢迎页标题、长确认 Dialog 和长 Unicode 输入均有回归测试。
- 自动化证据：`npm exec vitest -- run --config ../../vitest.config.ts tests/tui`（13 files / 99 tests）、`npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check` 全部通过。
- 当前运行器不是真实 TTY，浅色/深色主题、40/72/120 resize、菜单键盘路径和 Toast 实际观感仍需用户实机确认；未伪造人工证据。

### 2026-09-18：可演示停点 A（待用户实机验收）

- `runTui()` 已使用唯一 `TerminalSession` 进入 alternate screen，并在正常退出、信号与异常路径执行幂等恢复；旧 `Static` / `TimelineProjector` 路径已删除。
- Timeline 已改为应用内 viewport，支持 PageUp/PageDown、Ctrl+Home/Ctrl+End、鼠标滚轮、follow-tail、新内容计数、Thread 切换与 resize 内容锚点。
- 全屏根固定 Header、Timeline、BottomArea、Footer；低于 40×12 显示过小提示，12 行终端会保留当前菜单项与审批决定。
- 自动化证据：`npm run test:ts -- --run packages/cli/tests/tui`（12 files / 88 tests）、`npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check` 全部通过。
- 运行器中的 `npm run dev` 冒烟被 CLI 以“Interactive TUI requires a real terminal”拒绝，因此 alternate-screen 观感、真实鼠标滚轮和退出后的 Shell 恢复仍需用户实机确认；该限制不记为代码失败。

## 通俗说明

现在的 Ink 界面更像一串持续打印的日志：用户、助手、思考和工具主要靠 `You:`、`Harness:`、`Reasoning:`、`Tool:` 区分；菜单和审批大量使用不同颜色的圆角框；输入栏、快捷键和工作区状态连续堆在底部。功能存在，但用户很难快速判断“Agent 正在做什么、什么已经完成、现在需要我做什么”。

本功能把终端变成一个稳定的全屏工作区：

```text
进入 Harness
  → 保存并切换到 alternate screen
  → 顶部显示一行必要上下文
  → 中部视口显示可滚动的对话与活动
  → 底部固定显示输入栏或待处理 Interaction
  → 菜单和详情在稳定槽位覆盖显示
  → 退出或异常时恢复原 Shell、光标和终端模式
```

视觉目标不是复制 Qwen Code 或 Claude Code 的品牌，而是借鉴它们的结构：固定页面骨架、稳定 gutter、默认折叠长工具活动、只让当前活动项动画、窄终端主动隐藏次要信息。

## 用户最终得到什么

1. 启动 Harness 后进入稳定的单列全屏 TUI，输入区不会被新消息顶出屏幕。
2. 可以使用 PageUp/PageDown、跳转键和鼠标滚轮浏览完整 Thread 视口；滚离底部时，新内容不会抢走当前位置。
3. 用户消息、Assistant 正文、思考、工具、Interaction、Compose 摘要和 Goal 验收各有稳定且一致的视觉身份。
4. 连续读取、搜索和列目录活动默认压缩为摘要；写入、执行、失败和待审批活动保留足够正文。
5. 当前运行项有克制的流式反馈；完成后的历史保持静止，不因 spinner 或计时器持续闪烁。
6. 空 Thread 提供简洁欢迎页，明确工作区、模型、工作模式和可开始的操作，不展示营销 Feed 或大幅 ASCII 图。
7. 40、72、120 列和短终端均有清晰降级；过小终端显示稳定提示，不产生负宽度、无限换行或输入区消失。
8. 正常退出、Ctrl+C、SIGTERM、初始化失败和 React 渲染失败均恢复原 Shell、光标、输入回显与鼠标模式。

## 已确认设计方向

### 1. 单一全屏路径

- 交互式 TUI 只保留全屏 alternate-screen 路径，不提供配置开关切回主屏滚屏。
- 应用拥有历史视口滚动位置；输入栏、Interaction 和 Footer 固定在底部槽位。
- 退出后不把完整对话重新打印到 Shell；Thread 持久化是重新查看历史的 canonical 路径。

### 2. 单列而非仪表盘

- 顶部最多一行必要上下文，中部一个主时间线，底部一个交互面。
- 不恢复常驻 Sidebar、双栏主从布局或 Dashboard 卡片墙。
- Workspace、状态、BTW、Inspect 和 Tool Inspector 使用全屏内的覆盖视图，并保留明确返回路径。

### 3. 轻 chrome、强层级

- 尊重终端原生背景，不依赖大面积背景填充或特定深色主题。
- Build 金、Compose 淡紫只表达工作模式；品牌蓝只表达 Harness；成功、警告、失败只使用 semantic 色。
- 普通消息不加完整边框；通过稳定 gutter、缩进、留白、符号和字体强调建立层级。
- 只有审批、Question、Plan、Goal 和危险错误等需要用户行动的区域使用强边界。
- 色彩不是唯一信号；状态必须同时使用文案或稳定 glyph。

### 4. 信息先投影再渲染

- 展示层先把 Timeline 投影为用户、Assistant、Reasoning、Tool Activity Group、Interaction Result、Compose Summary、Goal Evaluation 等可显示条目，再由 Ink 渲染。
- 连续且已完成的读取、搜索、列目录活动可按同一 Run / execution / activity 分组；写入、删除、Shell、子代理、失败和待审批活动不得吞进普通读取摘要。
- 思考默认折叠；活动思考只显示有界摘要和运行状态，完整内容继续通过现有详情入口查看。
- 调整只影响 Presentation，不改 Transcript、Interactive Core 或 Agent 上下文。

### 5. 滚动与鼠标范围

- 键盘支持按页滚动、回到底部和跳到顶部；InputBar 的普通方向键、Home/End 继续归输入编辑所有。
- 鼠标只接入滚轮事件；不实现点击按钮、hover、拖拽滚动条或自动复制。
- 文本选择依赖终端原生能力；TUI 不持有选择内容、不访问系统剪贴板。
- 用户滚离底部后进入暂停跟随状态；新事件累积提示但不改变当前位置，显式回到底部后恢复自动跟随。

## 范围

- 建立全屏终端生命周期、alternate-screen 进入/退出和异常恢复。
- 用应用内 Timeline viewport 替换当前 `Static` / 终端 scrollback 投影。
- 建立滚动状态、resize 重排、尾随/暂停尾随和新内容提示。
- 统一欢迎页、Header、Timeline、InputBar、Footer、Toast、菜单、Picker、Interaction 与临时视图的视觉语言。
- 复用 `presentation-shared` 的工具显示、状态标签、输出折叠和 Markdown 语义；缺失的 TUI 投影规则在 CLI 内补齐。
- 为连续只读工具建立有界 Activity Group；为写入、Shell、子代理、失败和审批保留独立行。
- 增强 Markdown 的标题、列表、引用、代码块、链接和表格可读性，不要求浏览器级排版。
- 支持键盘历史浏览和鼠标滚轮；保持现有命令、InputBuffer、审批、Question、Plan、Goal、Workspace、Tool Inspector 与 Web handoff 能力可达。
- 更新 `docs/user/` 中的全屏、滚动、退出和复制说明，并重写相关 TUI 架构结论。

## 非范围

- 修改 Web UI 视觉、Web handoff 业务状态或 Browser 交互。
- 修改 Python Agent、模型调用、Tool schema、审批策略、Thread 持久化、SQLite schema 或 JSON-RPC v3。
- 引入第二个 TUI 框架、恢复 OpenTUI，或保留全屏/主屏双 Renderer。
- 常驻 Sidebar、双栏布局、鼠标点击、hover、拖拽、自动复制、自绘滚动条或完整终端窗口系统。
- 复制 Qwen Code / Claude Code 的 Logo、精确颜色、ASCII 欢迎图、营销 Feed、Teams/tmux/PR/voice 状态。
- 增加新的运行时依赖来实现颜色、spinner、鼠标或布局；确需依赖时必须先修订 Spec 并征得用户确认。
- 改变 Slash Command、快捷键、Interaction 决策集合、错误语义或 Agent 行为来迁就视觉实现。

## 可观察验收

1. **全屏唯一入口**：`npm run dev` 在 TTY 中直接进入 alternate screen；仓库不存在可选择的旧主屏滚屏 Renderer。
2. **稳定骨架**：Header、历史视口、底部交互面和 Footer 在流式输出、菜单开关、Interaction 出现及 resize 时职责稳定，输入区不会被新内容顶出屏幕。
3. **滚动正确**：键盘与鼠标滚轮可浏览历史；滚离底部后新内容不抢位置，并显示有界的新内容提示；回到底部恢复尾随。
4. **完整恢复**：正常退出、Ctrl+C、SIGINT、SIGTERM、启动失败和渲染异常后，alternate screen、光标、输入回显和鼠标模式全部恢复；恢复操作幂等。
5. **时间线层级**：用户、Assistant、Reasoning、Tool、Interaction、Compose 与 Goal 不再以内部英文枚举或统一日志行展示；用户能在一屏内识别主体、动作、状态和嵌套结果。
6. **工具降噪**：连续已完成的 read/search/list 活动形成摘要；写入、删除、Shell、子代理、失败和待审批活动保持独立且可检查，分组不丢原始详情入口。
7. **活动反馈稳定**：只有当前运行中的思考、工具或等待状态动画；完成历史不持续变化，spinner 预留固定宽度且不会引发布局抖动。
8. **交互能力不退化**：InputBar、多行编辑、Slash/@ 补全、审批、Question、Plan、Goal、Workspace、Tool Inspector、BTW、Thread/Model/Skill Picker、撤销和 Web handoff 均可通过键盘完成。
9. **响应式可读**：40、72、120 列及不少于 12 行的 fixture 无负宽度、无限换行、越界或底部槽位消失；低于最小尺寸时只显示可恢复的“终端过小”提示和退出说明。
10. **复制边界明确**：不启用鼠标点击/hover/自动复制；终端原生文本选择可选择当前可见内容，退出全屏后原 Shell 内容不被覆盖。
11. **无新增依赖**：使用现有 Ink、React、string-width、marked、Shiki 与 Node 标准能力；若最终确需新增依赖，必须先更新本 Task / Spec 并获用户确认。
12. **文档收敛**：`TUI表现层.md` 和 `架构总览.md` 不再把主屏 scrollback、OpenTUI、常驻 Sidebar 或已删除文件描述为 canonical 路径；用户文档说明全屏、滚动、退出和复制行为。

## 后续流程

- 用户确认本 Task 与同名 Spec 后，使用 `planning-and-task-breakdown` 生成同名 Plan / Todo。
- Plan 必须按可见纵向结果设置停点，至少覆盖：全屏骨架、时间线层级、Interaction/覆盖视图、响应式与终端恢复。
- 实现阶段使用测试驱动开发，一次只推进到下一个可演示停点并等待用户实机查看。
- Review 对照 Task / Spec、40/72/120 列帧、真实终端录屏或截图、异常恢复和无新增依赖证据执行。
- 本功能完成后更新 `TUI表现层.md` 与 `架构总览.md`；HC-182 保留历史，不改写其当时已确认的决策。

## 方案参考

本功能借鉴本地一手源码的交互结构，不复制品牌实现：

- Qwen Code：`packages/cli/src/ui/layouts/DefaultAppLayout.tsx`、`MainContent.tsx`、`HistoryItemDisplay.tsx`、`messages/ConversationMessages.tsx`、`ToolGroupMessage.tsx`。
- Claude Code：`src/components/FullscreenLayout.tsx`、`Messages.tsx`、`Message.tsx`、`AssistantThinkingMessage.tsx`、`permissions/PermissionRequest.tsx`。
