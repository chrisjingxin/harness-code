# HC-183 全屏 TUI 视觉重构实施计划

关联：[Task](../task/HC-183-全屏TUI视觉重构.md) · [Spec](../spec/HC-183-全屏TUI视觉重构.md) · [Todo](../todo/HC-183-全屏TUI视觉重构.md)

本计划只把已确认 Spec 转为依赖有序的实施步骤，不增加范围。实施阶段必须使用测试驱动开发；一次只推进到下一个可演示停点，更新 Todo 和 `tmp/handoff.md` 后停止，等待用户实机查看。

## 1. 交付概览

当前 Ink TUI 使用 `Static` 把完成历史写入终端 scrollback，只重绘底部 live 区。目标是用唯一的 alternate-screen 全屏路径替换它：Harness 管理可滚动的 Timeline viewport，输入或 Interaction 固定在底部，菜单与详情使用覆盖视图，退出及异常时恢复原 Shell。

实施不是把旧 OpenTUI 搬回来，也不是先做一套通用终端框架。只建立三个有真实复杂度的深 Module：

- `TerminalSession`：隐藏 alternate screen、raw input、滚轮、resize 与幂等恢复；
- `TimelineViewport`：隐藏 cell wrap、anchor、page scroll、follow-tail 与新内容计数；
- `FullscreenProjection`：隐藏 Timeline 分组、折叠和用户可见文案。

React/Ink 组件负责组合和绘制，不拥有业务状态或终端控制码。`TuiAdapter` 保持现有 snapshot / intent interface，滚动和像素状态不进入 Interactive Core。

## 2. 依赖图与实施顺序

```text
TerminalSession lifecycle ──────┐
                                ├─ Fullscreen root + stable slots ── visual shell
TimelineViewport pure state ────┘                                  │
                                                                   ├─ menus/input/footer
presentation-shared policies ── FullscreenProjection ── timeline ──┤
                                                                   └─ Interaction/Overlay

全部纵向能力
  → 40/72/120 与短终端矩阵
  → 文档、旧路径删除、项目级检查
  → Review
```

高风险 seam 前置：若 Ink 6.8.0 无法在不新增依赖的前提下可靠接收鼠标滚轮，或启用滚轮所需 mouse reporting 破坏可接受的终端原生选择，必须在停点 A 前停止并回写 Spec，不得静默删掉验收。

## 3. 架构决策

### 3.1 全屏生命周期只有一个 owner

`runTui()` 创建一个 `TerminalSession`，先完成可回滚的 `enter()`，再挂载 Ink root；根 `finally` 无条件调用幂等 `close()`。React effect 可以订阅 resize/wheel，但不是恢复的最终 owner。任何组件不得直接写 alternate-screen、cursor 或 mouse ANSI。

### 3.2 viewport 是表现状态，不是业务 intent

滚动位置、anchor、follow-tail、新内容数量和物理行布局只存在于 Ink Presentation。`TuiAdapterSnapshot` 不增加行号或 scroll offset，`TuiIntent` 不增加 `mouse-wheel`、`scroll-up` 等像素动作。

### 3.3 先投影，再测量，再绘制

完整流程固定为：

```text
TimelineItem[]
  → projectFullscreenTimeline()
  → FullscreenEntry[]
  → layoutViewport(entries, state, size)
  → 可见 entry fragments
  → Ink components
```

Tool Group、Reasoning 折叠、中文状态和 semantic tone 在纯投影阶段完成。wrap、cell width 与 anchor 在 viewport 阶段完成。React 组件不重复判断工具分类或业务状态。

### 3.4 保持单列和最少 chrome

全屏根只保留 Header、TimelineViewport、BottomArea、Footer 四槽。普通 Timeline 不画完整边框；只有需要用户行动的 Interaction 使用强边界。wide 终端只增加信息量，不增加 Sidebar。

### 3.5 无新增依赖

滚轮输入使用 Node TTY 与已有输入流；spinner 使用稳定 glyph 序列；颜色继续从现有 `tuiTheme` 获取。若任何一项需要新包，先暂停并请求用户修订 Spec。

## 4. 工作包与验证

### WP1：TerminalSession 生命周期与恢复 seam

**目标**：在不切换生产路径的前提下，用 TDD 建立唯一的终端控制 owner，先证明 enter/close、部分失败、重复 close、signal cleanup、resize 与 wheel 解码可测。

**主要改动**：

- 新增 `packages/cli/src/tui/ink/terminal-session.ts`，依赖以 stream/callback 参数注入，不在 Module 内偷偷读取全局对象；
- 为 alternate screen、cursor、mouse reporting、raw mode 与 listener 建立完成步骤记录和逆序恢复；
- 新增 focused tests，覆盖成功、每个进入点失败、部分 enter、重复信号、非 TTY、畸形 mouse sequence；
- mouse 只产生 wheel event，未知序列不进入 InputBuffer。

**验证**：focused TerminalSession tests；现有 `ink-app` / input tests 不变。此工作包不单独形成用户演示停点。

**预计文件**：2～3 个，M。

### WP2：TimelineViewport 纯状态与布局 seam

**目标**：先用纯测试固定 PageUp/PageDown、Ctrl+Home/End、follow-tail、新内容计数、resize anchor、BottomArea 高度变化和 too-small 规则。

**主要改动**：

- 新增 `timeline-viewport.ts`，使用稳定 entry id + entry 内相对位置保存 anchor；
- 以 terminal cell width 而非字符串长度计算可见行；尺寸一律 clamp 为非负整数；
- 用户向上滚动后暂停尾随，新内容只累积提示；到达底部、提交 Prompt 或切 Thread 恢复尾随；
- 保持普通方向键/Home/End 归 InputBuffer，viewport 只接收已解析的语义导航动作。

**验证**：40/72/120 列、12/17/24 行、空/单条/长 Thread、Unicode、resize 与 streaming fixture 的纯测试。此工作包不单独形成用户演示停点。

**预计文件**：2～3 个，M。

### WP3：接通唯一全屏根、滚动与最小响应式骨架

**目标**：把 WP1/WP2 接入生产 `runTui()`，替换 `Static`/scrollback 投影，形成首个可运行的全屏界面。

**主要改动**：

- `runTui()` 在 mount 前 enter、finally close；Web handoff 继续使用同一个 session；
- 根布局固定 Header / TimelineViewport / BottomArea / Footer，现有 InputBar 与 Timeline 内容先原样接入；
- 增加 PageUp/PageDown、Ctrl+Home/End 与 wheel owner 路由，遵守菜单/Interaction/Overlay 优先级；
- 删除不再使用的 `TimelineProjector` / `Static` 路径及对应旧测试，迁移为全屏 viewport 测试；
- `<40` 列或 `<12` 行只显示终端过小提示，resize 达标后原地恢复。

**验证**：focused root/shortcut/web-handoff tests、typecheck、真实终端进入/退出/resize/滚动检查。

**预计文件**：4～5 个，M。

## 可演示停点 A：全屏骨架与历史滚动

用户查看方式：

1. 执行 `npm run dev`，确认 Harness 进入 alternate screen，输入区固定在底部；
2. 打开一个有足够历史的 Thread，使用 PageUp/PageDown、Ctrl+Home/End 和鼠标滚轮浏览；
3. 滚到上方后等待新输出，确认位置不跳并出现新内容提示；
4. 调整终端到 40、72、120 列及小于 40×12，确认正常重排或显示过小提示；
5. 正常退出与发送 SIGTERM，确认恢复进入前的 Shell、光标和输入回显。

完成停点 A 后勾选对应 Todo、记录 focused tests 与实机结果、更新 `tmp/handoff.md`，停止等待用户确认。

### WP4：统一 theme token、Header、欢迎页与 Footer

**目标**：把现有 `tuiTheme` 变成 Ink 唯一色值来源，形成克制的页面外壳和空 Thread 首屏。

**主要改动**：

- 删除失效或含义重叠 token，补齐 brand、mode、text、selection、semantic、tool tone；
- 清除 Ink 组件中的 raw `cyan/yellow/green/magenta/red` 和散落颜色值；
- Header 按 Harness/Thread、mode、model、workspace、状态优先级单行降级；
- 欢迎页只显示版本、workspace、model、mode 与不超过三个真实入口；
- Footer 按宽度/高度隐藏次要信息，compact 只保留活动状态和必要提示。

**验证**：theme purity tests、40/72/120 welcome/header/footer frame tests；浅色/深色终端人工检查。

**预计文件**：3～5 个，M。

### WP5：重做 InputBar、菜单、Picker 与 Toast 槽位

**目标**：底部交互面使用统一密度和选中态，普通开关不再推动 Timeline anchor。

**主要改动**：

- InputBar 保留 Unicode/多行/历史行为，以当前模式主题色绘制边框，只显示正文和有界快捷键提示，不重复 Header/Footer 的模式与工作区信息；最多 6 个视觉行；
- Command、mention、Skill、Thread、Model、Agent、Undo 使用共享菜单骨架、行高、空态、截断和 Footer；
- 选中态使用 accent marker + 文本强调，不只依赖 inverse；
- Toast 进入稳定覆盖槽位，不插入历史、不改变 BottomArea 高度；
- 现有快捷键 owner 与 submit/block 语义不变。

**验证**：InputBuffer 回归、menus tests、toast timer tests、BottomArea 高度/anchor 集成测试。

**预计文件**：3～5 个，M。

## 可演示停点 B：完整全屏外壳

用户查看方式：

1. `npm run dev` 打开空 Thread，查看欢迎页、Header、InputBar 和 Footer；
2. 输入 `/`、`@`，打开 Thread/Model/Skill/Undo Picker，确认菜单风格、选中态和空态统一；
3. 切换 Build/Compose 与审批模式，确认只在对应位置使用 mode/semantic 色；
4. 在 40、72、120 列间 resize，确认 Header/Footer 主动降级，输入与菜单仍可用；
5. 触发一次 Toast，确认不会挤压历史或输入区。

完成停点 B 后更新 Todo 与 handoff，停止等待用户确认。

### WP6：FullscreenProjection 与 Tool Activity Group

**目标**：建立纯展示投影，先固定消息类型、中文文案、Reasoning 折叠和只读工具分组边界。

**主要改动**：

- 新增 `fullscreen-projection.ts` 与 focused tests；
- 复用 `toolDisplay()`、`toolPrimaryArgument()`、`toolStatusLabel()`、`interactionStatusLabel()` 和现有 paint budget；
- 只合并同 run/execution/activity、连续、已完成的 read/search/list；
- write/edit/delete/execute/task、running/failed、未知 MCP/Plugin 与安全交互工具始终独立；
- 每个分组仍保留原始 tool id 和 Tool Inspector 可达信息。

**验证**：确定性、无输入 mutation、所有分组边界、恢复 Thread 和 child execution fixture。

**预计文件**：2～4 个，M。

### WP7：按类型重绘 Timeline 与活动反馈

**目标**：用投影条目替换当前 `TimelineLine` 日志式输出，建立稳定 gutter、缩进、状态 glyph 与 active-only animation。

**主要改动**：

- 用户消息显示所属 mode accent，Assistant 正文成为主体，不再显示 `You:` / `Harness:`；
- Reasoning 活动时显示有界摘要与固定宽 spinner，完成后折叠静止；
- Tool Group、独立工具、Interaction Result、Compose Summary、Goal Evaluation 和 child timeline 使用中文 semantic presentation；
- nested output 使用统一 gutter，失败/取消同时有 glyph 与文案；
- fake timer 证明只有活动项变化，完成历史帧不随时间变化。

**验证**：timeline frame tests、streaming → final、tool running → completed/failed、child/compose/goal fixtures。

**预计文件**：3～5 个，M。

### WP8：Markdown 与长内容在 viewport 内可读

**目标**：在不新增依赖的前提下补齐 heading、emphasis、inline code、fenced code、list、blockquote、link 与 table 的终端呈现和窄屏降级。

**主要改动**：

- 扩展现有 `MarkdownText`，解析失败逐条降级有界纯文本；
- fenced code 显示语言和有界正文，Shiki 不可用不影响阅读；
- table 在宽屏对齐、compact 纵向降级；link 显示标签与可识别 URL，不发网络请求；
- 所有 wrap/截断按 cell width，长代码/链接不能撑破 viewport。

**验证**：Markdown focused tests，40/72/120 列 heading/list/code/link/table fixture，中文/emoji/组合字符。

**预计文件**：2～4 个，M。

## 可演示停点 C：可扫描的对话与工具活动

用户查看方式：

1. 打开或创建一段包含普通消息、流式回答、思考、读取、搜索、写文件、Shell、子代理和失败工具的会话；
2. 确认连续只读工具被压缩，写入/Shell/失败/子代理保持独立且详情仍可查看；
3. 确认当前活动项有反馈，完成历史完全静止；
4. 查看包含标题、列表、引用、代码、链接和表格的 Assistant 回答；
5. 在 40、72、120 列确认层级、gutter 和 Markdown 仍可读。

完成停点 C 后更新 Todo 与 handoff，停止等待用户确认。

### WP9：统一 Approval / Question / Plan / Goal

**目标**：把所有 pending Interaction 放入同一个底部 shell，同时保留每类交互的风险正文与现有决策集合。

**主要改动**：

- Approval 按文件 mutation、Shell、通用工具展示 operation/path/diff/command 与风险；
- Directory Trust、Question、多选/custom input、Plan feedback、Goal criteria 使用统一标题/选项/Footer；
- options 只来自现有 policy，不新增、删除或重排安全决定；
- 决策完成后 Timeline 只留中文结果摘要，不重复完整交互卡；
- 小高度确保主要内容、当前选项和确认方式可见，长正文有界滚动/截断。

**验证**：bottom-area focused tests、每种 Interaction 键盘路径、40×12 与 72×24 frame tests。

**预计文件**：3～5 个，M。

### WP10：统一覆盖视图与 Web handoff 状态页

**目标**：Workspace、Status、BTW、Inspect、Tool Inspector、文件预览和 Web handoff 使用稳定 Overlay shell，并各自拥有滚动 owner。

**主要改动**：

- 统一 title/body/footer、Esc 返回、空态/错误态与最上层滚轮 owner；
- 打开/关闭覆盖视图保持 draft、Timeline anchor 与 follow-tail 状态；
- Workspace/文件预览保留键盘导航与 `@` 插入，Tool Inspector 保留原始详情；
- Web active 时冻结 Timeline，显示单一接管页；return 后用同一 TerminalSession 原地恢复；
- 覆盖视图不创建第二个 root 或 TerminalSession。

**验证**：menus/temporary-view/web-handoff tests、overlay wheel/close/anchor 集成测试。

**预计文件**：3～5 个，M。

### WP11：响应式与长内容回归矩阵

**目标**：对完整界面执行跨状态、跨尺寸和 Unicode/长内容验证，补齐遗漏但不新增产品范围。

**主要改动**：

- 建立 40/72/120 列、12/17/24 行代表帧，覆盖 welcome、conversation、streaming、tool group、Interaction、menu、Overlay、too-small；
- 验证 resize anchor、长 Thread、长路径/命令、Unicode、多行输入和新内容提示；
- 将重复 fixture 和结构断言收敛在现有 TUI test helpers，不建立产品态 visual-test framework。

**验证**：完整视觉帧 focused suite；真实终端三种宽度截图/录屏。

**预计文件**：2～4 个，M。

### WP12：终端恢复与长会话性能硬化

**目标**：集中验证异常路径与 streaming 性能，使恢复和有界重排成为可重复证据。

**主要改动**：

- 验证 TerminalSession enter 每个失败点、render error、Ctrl+C、SIGINT/SIGTERM、sidecar/Web handoff close 的恢复；
- 固定长 Thread + streaming fixture，记录投影/测量缓存或等价有界策略的性能证据；
- 对发现的恢复/重排缺陷只修改对应深 Module，不在测试中放宽 invariant。

**验证**：terminal lifecycle suite、长会话性能 fixture、真实终端异常退出检查。

**预计文件**：2～4 个，M。

### WP13：旧路径清理与完整 TUI 回归

**目标**：删除被新 canonical 路径取代的实现，并证明现有交互能力没有靠 fallback 存活。

**主要改动**：

- 清除 Static projector、raw color、旧测试、死 import 和主屏 scrollback fallback；
- 检查 Slash/@、Picker、Undo、Workspace、Tool Inspector、Interaction、child timeline 与 Web handoff focused suites；
- 运行完整 TUI suite、typecheck 与 build，修复同一 seam 内的回归。

**验证**：TUI focused suite、`npm run typecheck`、`npm run build`；全仓搜索无旧 canonical 标识。

**预计文件**：3～5 个，M。

### WP14：用户文档、架构收敛与项目级验收

**目标**：把已落地行为写回 canonical 文档并准备 Review，不在文档阶段改变代码契约。

**主要改动**：

- 更新 `docs/user/交互使用.md`：全屏、滚动、退出、复制、too-small、Overlay；
- 更新 `docs/user/故障排查.md`：终端未恢复、滚轮不可用、尺寸与兼容说明；
- 重写 `docs/developer/architecture/TUI表现层.md` 的 OpenTUI/主屏 scrollback/Sidebar 旧结论；
- 增量更新 `架构总览.md` 中 Bun/OpenTUI 与旧安装/运行描述；
- 运行 `npm run project:check`、`npm run typecheck`、`npm run test`、`npm run build`，记录允许的 sandbox 跳过；
- 使用 `code-review-and-quality` 对照 Task / Spec / Todo 完成 Review，结论回写 Task 后再走完成归档。

**预计文件**：文档分组执行，每个提交不超过 5 个文件，M。

## 可演示停点 D：完整全屏 TUI 验收

用户查看方式：

1. 在真实终端走欢迎页 → 对话 → 工具 → 审批/问答 → Workspace/Tool Inspector → Web handoff 返回 → 退出；
2. 在 40、72、120 列与短高度查看同一会话，确认响应式降级；
3. 使用键盘和鼠标滚轮浏览，滚离底部观察新内容提示，再回到底部；
4. 使用终端原生方式选择当前可见文本，确认 TUI 不自动复制或拦截点击；
5. 正常退出、Ctrl+C 和 SIGTERM 后检查原 Shell、光标和回显。

用户确认停点 D 后才进入 Review/完成流程；不得把“自动化通过”代替用户可见验收。

## 5. 测试矩阵

| 层级 | 重点 | 主要证据 |
| --- | --- | --- |
| 纯投影 | Tool Group、Reasoning、中文标签、Markdown 降级 | Vitest deterministic fixtures |
| 纯 viewport | anchor、follow-tail、page scroll、resize、cell width | 40/72/120 × 12/17/24 tests |
| Terminal adapter | enter/close、部分失败、signal、wheel、non-TTY | fake streams + ANSI recorder |
| Ink integration | 固定槽位、owner 优先级、streaming、Interaction、Overlay | real Ink mount + fake timers |
| 视觉帧 | welcome、conversation、menu、approval、too-small | structural frame assertions |
| 实机 | alternate screen、滚轮、选择、resize、Shell 恢复 | 截图/录屏与人工记录 |
| 项目级 | build/typecheck/tests/docs/tasks/protocol | npm scripts 输出 |

真实模型、真实凭据和公网访问不进入自动化。需要会话内容的测试使用稳定 fixture；实机演示可使用用户已有配置，但不得把内容或密钥写入仓库。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Ink 没有内置 ScrollBox | 高：可能出现自造框架或长会话卡顿 | 视口只解决本产品需要的行布局/anchor；先做纯 Module 和长 Thread fixture，不实现通用窗口系统 |
| mouse reporting 与终端选择冲突 | 高：滚轮可用但文本难复制 | 只开启最小 wheel 模式，保留终端修饰键选择；停点 A 实机验证，失败时回写 Spec 请用户决策 |
| 异常退出污染 Shell | 高：终端不可用 | TerminalSession 单 owner、完成步骤日志、逆序恢复、根 finally、逐失败点测试 |
| 流式 token 导致全历史重排 | 高：CPU/闪烁 | Projection/测量缓存、稳定 entry id，只重新计算活动条目与受影响可见窗口；长 Thread benchmark fixture |
| BottomArea 高度变化导致阅读位置跳动 | 中 | anchor 基于稳定 entry id；菜单/Toast 尽量覆盖；集成测试各 owner 切换 |
| 工具分组隐藏重要副作用 | 高 | 分组白名单仅已完成 read；write/execute/task/failed/unknown 永远独立，详情 id 保留 |
| 旧 OpenTUI 文档误导实现 | 中 | WP14 重写 canonical 架构；Plan/Todo 只引用现有 Ink 路径 |
| 视觉快照脆弱 | 中 | 断言结构、文案、行数和 ANSI 语义，不锁终端近似 RGB；人工截图补足 |

## 7. 并行与顺序约束

- WP1 与 WP2 可在 interface 固定后并行探索，但接入生产的 WP3 必须等两者完成。
- WP4 与 WP6 的纯 token/projection 部分可并行；任何共享 `app.tsx` / layout 编辑必须串行集成。
- WP8 Markdown 可在 WP6 interface 固定后与 WP7 部分并行，但最终 frame 由 WP7 集成。
- WP9 与 WP10 共享 BottomArea/Overlay owner 和 shortcut 优先级，必须串行或明确文件所有权。
- WP11～WP14 只在前述功能稳定后开始；Review 不与未完成实现并行。

当前计划不授权自动派生多个实现 Agent；实施时如需并行，根 Agent 必须先按文件和 seam 明确所有权。

## 8. 开放问题

无。mouse reporting 与终端原生选择的兼容性是已知验证门槛，不是实现 Agent 可自行改变的设计；若停点 A 证明不可兼容，暂停并请求用户决策。
