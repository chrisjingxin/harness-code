# HC-183 全屏 TUI 视觉重构规格

关联任务：[HC-183](../task/HC-183-全屏TUI视觉重构.md)  
前置迁移：[HC-182](../task/HC-182-Node与Ink运行时迁移.md)  
历史视觉任务：[HC-145](../task/archive/HC-145-TUI视觉与渲染重构.md)  
架构入口：[架构总览](../architecture/架构总览.md)、[TUI 表现层](../architecture/TUI表现层.md)

用户结果、范围与验收以 Task 为准。本文固定全屏 Ink Presentation 的 Module、Interface、Seam、布局、滚动、终端生命周期、展示投影、错误语义、测试口径与非范围；不规定实施顺序。Plan / Todo 必须与本文同名，不得重新选择 TUI 框架、恢复主屏滚屏或扩展 Web / Agent 范围。

## 1. Objective

HC-182 已建立 Node.js、npm、Ink 6.8.0 和 `TuiAdapter` 的 canonical 路径，但为降低迁移风险选择了 `Static` + 终端 scrollback：完成记录一次性打印，当前活动和输入只在底部动态渲染。这个形态能闭环功能，却无法提供稳定的全屏页面骨架、固定输入区、应用内历史导航和覆盖视图，也让原 OpenTUI 的视觉 token、共享展示策略和现有 Interaction 状态没有形成一致体验。

本功能交付唯一的全屏 Ink TUI：

```text
InteractiveController（业务事实不变）
  → TuiAdapter snapshot / intent（业务 seam 不变）
  → FullscreenProjection（分组、折叠、视觉语义）
  → TimelineViewport（应用内滚动与尾随）
  → Ink FullscreenApp（Header / Viewport / BottomArea / Footer / Overlay）
  → TerminalSession（alternate screen、鼠标滚轮、光标与恢复）
```

成功标准是“用户始终知道当前上下文、Agent 正在做什么、哪里需要自己操作”，而不是视觉元素越多越好。实现必须保留现有领域事实和键盘能力，删除主屏滚屏这条已被新决策取代的表现路径。

## 2. 已确认决策与术语

以下决策来自 Task，Spec 不得改写：

1. 全屏 alternate-screen 是唯一交互式 TUI，不保留主屏 scrollback 配置或 fallback Renderer。
2. 页面采用单列骨架，不恢复常驻 Sidebar；Workspace、状态和工具详情使用覆盖视图。
3. 应用拥有历史滚动；支持键盘与鼠标滚轮，不实现点击、hover、拖拽、自绘滚动条或自动复制。
4. 用户滚离底部后暂停尾随；新内容不抢位置，显式回到底部后恢复自动尾随。
5. 允许在 Presentation 中对思考、工具与历史 Interaction 分组或折叠，但不改 Transcript、Interactive Core、命令、快捷键、审批或 Agent 行为。
6. 只修改 Ink TUI 与相关用户/架构文档；Web UI、Python Agent、SQLite 与 JSON-RPC v3 不变。
7. 不新增依赖；若发现现有栈无法安全满足鼠标或终端恢复，必须先修订 Task / Spec 并请求用户决定。

术语固定如下：

| 含义 | 术语 | 说明 |
| --- | --- | --- |
| 进入后由 Harness 占用、退出后恢复 Shell 的终端缓冲 | alternate screen / 全屏缓冲 | 不是新进程或桌面窗口 |
| 管理 alternate screen、光标、鼠标模式与恢复的深 Module | `TerminalSession` | 唯一终端控制码 owner |
| Header 与 BottomArea 之间的应用内历史区域 | `TimelineViewport` / 时间线视口 | 不写入 Shell scrollback |
| 自动显示最新内容 | 尾随 / follow-tail | 用户滚动时暂停 |
| Timeline 到可显示条目的纯投影 | `FullscreenProjection` | 不含 React、终端控制码或业务 mutation |
| 占据全屏内容层但不新建终端窗口的临时界面 | 覆盖视图 / `OverlayView` | Workspace、状态、详情等 |
| 底部输入界面 | 输入栏 / `InputBar` | 禁止称 Composer，避免与 Compose 模式混淆 |

HC-182 中的 committed/live `Static` 投影、主屏 scrollback 和“全宽临时视图”术语被本 Spec 取代；HC-182 文档作为历史记录保留，不回写。

## 3. Scope Check 与 Module Map

这是一个单一能力，不拆成多个平级 Task。全屏生命周期、视口、BottomArea 和响应式共享同一个终端状态；任何一块单独上线都会留下输入不可见、无法滚动或终端无法恢复的不可用中间态。

内部使用以下 Module，依赖单向流动：

| Module id | 职责 | 依赖 |
| --- | --- | --- |
| `terminal-session` | alternate screen、光标、鼠标滚轮模式、TTY resize 与幂等恢复 | Node TTY、Ink composition root |
| `fullscreen-projection` | Timeline 分组、折叠、文案、glyph、展示 tone 与有界详情 | Interactive snapshot、`presentation-shared` |
| `timeline-viewport` | 可见窗口、按页滚动、顶部/底部跳转、尾随暂停、新内容计数与 resize anchor | `fullscreen-projection`、终端尺寸 |
| `fullscreen-layout` | Header、Viewport、BottomArea、Footer、菜单与覆盖视图的稳定槽位 | 前述 Module、现有 `TuiAdapter` |
| `visual-language` | 主题 token、密度、边框、选中态、spinner 与响应式优先级 | 现有 `tuiTheme`、终端能力 |

`terminal-session` 与 `TuiAdapter` 之间不得建立依赖；Terminal 生命周期不进入业务 snapshot。`fullscreen-projection` 必须是无 React、无 Ink、无 I/O 的纯 Module。`timeline-viewport` 只持有本地表现状态，不增加 `TuiIntent`，除非后续发现滚动需要跨 Renderer 持久化并先修订 Spec。

## 4. Tech Stack、命令与工程位置

### 4.1 固定技术基线

- Node.js `>=20`、npm `10.9.3`。
- Ink `6.8.0`、React `19.2.6`。
- 继续使用现有 `string-width`、`marked`、`shiki` 与 Node 标准库。
- 不恢复 OpenTUI、`react-reconciler` 或 Bun，不引入新的 TUI、spinner、mouse、layout、color 或 virtualization 依赖。

### 4.2 开发与验证命令

```bash
npm run dev
npm run typecheck
npm run test:ts -- --run packages/cli/tests/tui
npm run build
npm run project:check
```

Plan 必须把 focused Vitest 命令改写为仓库实际可执行的精确参数；不得把真实模型调用作为视觉验收前置。实机演示使用 mock/fake timeline 或现有本地开发入口，不提交凭据。

### 4.3 工程位置

| 位置 | 职责 |
| --- | --- |
| `packages/cli/src/tui/ink/` | 全屏 composition、TerminalSession adapter、viewport 与 Ink 渲染 |
| `packages/cli/src/tui/presentation/` | TUI 私有 theme token 与纯展示模型；现有 `theme.ts` 继续作为单一事实源 |
| `packages/cli/src/presentation-shared/` | TUI/Web 已共享的工具标签、状态、输出折叠和 Markdown 纯策略 |
| `packages/cli/src/tui/application/` | 现有 `TuiAdapter` snapshot / intent；不承载像素、滚动或终端控制码 |
| `packages/cli/tests/tui/` | 纯投影、viewport、按键、终端恢复、布局帧与集成测试 |
| `docs/user/` | 全屏、滚动、退出、复制与窄终端说明 |
| `docs/developer/architecture/` | canonical Ink 全屏架构 |

禁止为每个视觉条目建立浅 wrapper。仅当一个 Module 隐藏了分组、测量、滚动或终端恢复复杂度时才新增文件/interface。

## 5. 总体布局 Interface

### 5.1 稳定页面骨架

全屏根布局必须始终占用当前 `stdout.columns × stdout.rows`，从上到下只有四个稳定槽位：

```text
Header             0 或 1 行；极短终端可隐藏
TimelineViewport   使用全部剩余高度；唯一主滚动 owner
BottomArea         InputBar / Interaction / menu / dialog 中的一个主 owner
Footer             0 或 1 行；按宽度和高度降级
```

覆盖视图在内容层替换 `TimelineViewport`，不创建第二个根布局，也不让 Header/Footer/InputBar 重复挂载。Command / mention suggestion 锚定在 BottomArea 上方；普通打开/关闭不能改变历史 anchor。需要更多高度的审批、Plan 或 Goal 可以占用 BottomArea 以上的受限区域，但必须保证主要决定和快捷键始终可见。

### 5.2 Header

Header 只显示能帮助用户判断当前上下文的事实，按优先级为：

1. Harness 标识与当前 Thread 短标题或“新会话”；
2. Build / Compose 模式；
3. 模型短名；
4. 工作区 basename；
5. 连接或只读子时间线状态。

Header 不显示完整绝对路径、完整 Profile ID、版本说明、营销文字或持续计时。宽度不足时从低优先级向高优先级隐藏，不能把 Header 换成多行。

### 5.3 BottomArea

BottomArea 继续遵守单 owner invariant：

```text
pending Interaction → InteractionPanel
command/dialog/menu  → 对应选择或确认界面
otherwise            → InputBar
```

InputBar 最多显示光标附近 6 个视觉行，并使用当前 Build/Compose 主题色绘制边框。Header/Footer 已经拥有的模式、输入模式和工作区信息不得在输入框重复；顶边保持纯边线，底边可嵌入有界的发送/换行提示。

菜单和 Picker 使用同一行高、选中态、空态与 Footer 文案。选中项不得仅依赖 `inverse`；必须同时使用 accent 标记和文本强调。

### 5.4 Footer

Footer 从左到右按优先级组合：活动/等待状态、审批模式、Git/工作区、上下文用量、快捷键提示。紧凑宽度只保留活动状态和一个上下文提示；极短高度可完全隐藏 Footer，但不能隐藏待处理 Interaction。

## 6. `terminal-session` Interface 与生命周期

### 6.1 深 Module Interface

`TerminalSession` 应隐藏控制序列、监听器与恢复顺序。调用方只需知道：进入、接收 resize/wheel、关闭。

```ts
type TerminalSessionEvent =
  | { type: "resize"; columns: number; rows: number }
  | { type: "wheel"; direction: "up" | "down"; steps: number }

interface TerminalSession {
  enter(): void
  subscribe(listener: (event: TerminalSessionEvent) => void): () => void
  close(): void
}
```

具体类型可在实现时按现有组合方式调整，但 Interface 必须保持同等小：React 不得直接散写 ANSI 控制序列，测试可以通过 fake stream 和 event adapter 驱动完整生命周期。

### 6.2 进入顺序

仅在以下条件全部满足时进入全屏：stdin/stdout 是 TTY、终端尺寸可读、输入 raw mode 可安全启用、Ink root 即将挂载。进入过程必须记录实际完成的步骤，使任一步失败都只逆序撤销已经完成的动作。

进入后：

- 切换 alternate screen 并清屏；
- 使用 Ink 所需的 raw input；
- 隐藏或交给 Ink 管理光标，不能出现两个 owner；
- 启用最小鼠标报告能力，仅解析滚轮；
- 注册 resize、结束信号和进程退出恢复路径。

### 6.3 退出与异常恢复

`close()` 幂等。恢复顺序必须覆盖：鼠标报告关闭、光标恢复、raw mode / 输入回显恢复、alternate screen 退出、监听器移除。正常退出、Ctrl+C 的三段语义、SIGINT、SIGTERM、sidecar 提前退出、初始化失败、React error boundary 和 Web handoff close 最终都调用同一个恢复路径。

不得依赖 React effect cleanup 作为唯一恢复保证；composition root 的 `finally` 仍是最终 owner。重复信号、重复 unmount 或 enter 未完成时调用 close 不得输出失配控制序列或抛出二次错误。

### 6.4 非 TTY 与小终端

- 非 TTY 不尝试 alternate screen 或鼠标模式，继续走现有无头/明确拒绝路径。
- `columns < 40` 或 `rows < 12` 时保持全屏 session，但只渲染“终端过小”、当前尺寸、最低尺寸和退出提示；resize 达标后原地恢复完整界面。
- terminal size 缺失或非正数按过小处理，不能构造负宽度。

### 6.5 鼠标与复制

只消费 wheel up/down；未知、畸形或部分鼠标序列被安全忽略并不得进入 InputBuffer。应用不处理点击、hover、drag 或 selection，不调用剪贴板。

鼠标报告模式必须允许用户借助终端修饰键或终端原生机制选择当前可见文本。各终端差异在用户文档说明，不承诺跨 viewport 选择不可见历史。

## 7. `fullscreen-projection` 展示规格

### 7.1 投影 Interface

纯 Module 接收完整 Timeline 和展示上下文，输出稳定、可测量、可分组的条目：

```ts
type FullscreenEntry =
  | UserEntry
  | AssistantEntry
  | ReasoningEntry
  | ToolActivityEntry
  | InteractionResultEntry
  | ComposeSummaryEntry
  | GoalEvaluationEntry

function projectFullscreenTimeline(
  items: readonly TimelineItem[],
  context: FullscreenProjectionContext,
): readonly FullscreenEntry[]
```

每个 entry 必须有稳定 id、语义 kind、状态、主文本和可选详情；不得携带 React node、Ink props、ANSI 或回调。投影重复执行必须确定性，不能修改输入 Timeline。

### 7.2 消息层级

- 用户消息：使用当前消息所属 Build/Compose mode 的 accent gutter；显示正文，不重复 `You:` 英文标签。
- Assistant：正文是视觉主体，使用中性色；不重复 `Harness:` 标签。流式状态由固定宽度的 active marker 表达。
- System：仅对用户有行动意义的事实显示，内部调试状态不得进入普通 Timeline。
- 中文界面不得回显 `Reasoning:`、`Tool:`、`Interaction:`、`Goal evaluation:` 等内部英文枚举。

### 7.3 Reasoning

- 活动中：显示固定 glyph、中文状态、最后一个有界摘要窗口和可选 elapsed；spinner 占固定宽度。
- 完成后：默认折叠为一行，不持续显示 elapsed 或动画。
- 失败/取消：使用 semantic 状态和简短文案，不把完整隐藏内容直接铺满 viewport。
- 展开详情继续受已有绘制预算约束；Presentation 折叠不得改写或丢弃 Core 原文。

### 7.4 Tool Activity Group

只允许以下已完成、连续、同 `runId + executionId + activityId` 且中间无 Assistant/User/Interaction 的只读工具进入同一 Group：

- `read_file`
- `grep`
- `glob`
- `ls`
- 等价且由 `toolDisplay()` 明确标记为 read 的内置工具

Group 显示总数、失败数和最近/代表性主参数；每个原始工具仍保留稳定 id 和 Tool Inspector 详情入口。以下工具始终独立：

- `write_file`、`edit_file`、`delete_file`；
- `execute`；
- `task` 及带 child execution 的委派；
- 状态为 running 或 failed 的任意工具；
- 未登记的 MCP / Plugin 工具；
- 具有审批、安全或用户交互含义的工具。

独立工具行复用 `toolDisplay()`、`toolPrimaryArgument()`、`toolStatusLabel()` 与现有输出预算；成功、失败、运行中均有 glyph + 文案，不能仅靠颜色。

### 7.5 历史 Interaction 与其它条目

- pending Interaction 只出现在 BottomArea，不在历史中重复绘制完整卡片。
- resolved Interaction 进入 Timeline 后压缩为一行结果，使用 `interactionStatusLabel()` 和必要的目标摘要。
- Compose Summary、Goal Evaluation 与 child timeline 使用现有领域字段和中文 Presenter；不得显示 raw enum。
- 错误区分可恢复提示、Run 失败和终端错误；只有会阻止继续操作的错误使用强边界。

### 7.6 Markdown

Markdown 必须可读地表达 heading、paragraph、emphasis、inline code、fenced code、list、blockquote、link 和 table：

- heading 通过权重与上下留白，不使用大面积彩色边框；
- fenced code 显示语言、缩进与有界内容，Shiki 不可用时纯文本降级；
- link 显示标签与可识别 URL，不执行网络请求；
- table 在空间足够时按列对齐，紧凑宽度允许降级为逐行 key/value；
- wrap 必须基于 terminal cell width，中文、emoji 与组合字符不按 UTF-16 长度测量。

## 8. `timeline-viewport` 状态与滚动语义

### 8.1 本地状态

Viewport 至少表达：当前 anchor、是否 follow-tail、可见高度、已知 entry revision 和未读新内容数。具体数据结构属于 implementation，但不得把行号或滚动 offset 写入 `TuiAdapterSnapshot`。

### 8.2 默认与尾随

- 首次进入或打开 Thread 时定位到最新内容并启用 follow-tail。
- follow-tail 下，流式增量和新条目保持最后一行可见；BottomArea 高度变化后重新计算剩余视口，不把内容盖住。
- 用户向上滚动一次即关闭 follow-tail；此后新内容不改变 anchor，只增加有界新内容提示。
- 用户显式跳到底部、提交新 Prompt 或切换 Thread 后恢复 follow-tail，并清零新内容提示。

### 8.3 键盘

在没有更高优先级菜单/Interaction/覆盖视图消费时：

| 输入 | 行为 |
| --- | --- |
| `PageUp` | 向上移动一页，页间保留至少一行上下文 |
| `PageDown` | 向下移动一页；到达末尾后恢复 follow-tail |
| `Ctrl+Home` | 跳到最早可见历史，暂停 follow-tail |
| `Ctrl+End` | 跳到最新内容并恢复 follow-tail |

InputBar 继续拥有普通 Up/Down/Left/Right/Home/End。菜单、Picker、Interaction、Overlay 的现有按键优先级高于 Timeline。不得让一次按键同时滚动 Timeline 和改变选项/输入光标。

### 8.4 鼠标滚轮

- wheel up/down 每个离散 step 移动稳定的少量视觉行；实现可按终端事件合并，但方向与最终 anchor 必须确定。
- 菜单或可滚动覆盖视图打开时，wheel 由最上层 owner 消费；否则由 TimelineViewport 消费。
- wheel 事件不得插入输入字符、提交消息、触发按钮或改变审批选择。

### 8.5 Resize 与 anchor

resize 后按稳定 entry id 与 entry 内相对位置保持阅读 anchor，而不是盲目保存旧物理行号。follow-tail 状态下直接保持尾部。重排不得重新进入 Thread、重复 dispatch intent 或丢失 InputBuffer。

长 Thread 不能在每个 token 上无界重做全部昂贵解析。Plan 必须定义并验证有界投影/测量缓存或等价策略；该缓存是 Presentation 实现细节，不进入业务 interface。

## 9. 视觉语言与响应式

### 9.1 Token

现有 `tuiTheme` 是唯一色值来源。实施前可删除失效 token、重命名语义不清 token并迁移所有调用方；不得建立第二套 Ink palette。

Token 至少覆盖：brand、Build/Compose mode、primary text、muted、subtle、border、selection、success、warning、danger、diff add/remove、thinking、tool read/write/neutral。组件只消费语义 token，不直接写 `cyan`、`yellow`、`magenta`、`green`、`red` 或散落 hex。

不强制填充整个终端背景；所有前景色必须在常见深色和浅色终端背景上保有可读降级。无 truecolor 时允许终端自行近似，但语义仍由 glyph 与文案保证。

### 9.2 密度与 chrome

- 普通 Timeline 不使用完整 box border；相邻 entry 通过 0～1 行留白和 gutter 区分。
- Menu/Picker 可以有单层边界；嵌套内容不再重复套圆角框。
- Interaction 使用一个外层强边界，diff、描述和选项在内部依赖缩进，不套第二层卡片。
- spinner、状态 glyph 和展开符号使用固定宽度，避免流式更新横向跳动。
- Toast 使用稳定覆盖槽位，不插入历史，也不推动 InputBar。

### 9.3 响应式等级

以可用 cell width 为准：

| 等级 | 宽度 | 行为 |
| --- | --- | --- |
| too-small | `<40` | 只显示尺寸提示与退出说明 |
| compact | `40–59` | 隐藏 Header 次要字段；Footer 只保留状态；工具参数强截断；表格纵向降级 |
| standard | `60–99` | 完整单列体验；显示主要状态和快捷键 |
| wide | `>=100` | 显示更多参数、diff 与上下文信息，但仍保持单列，不出现 Sidebar |

高度 `<12` 进入 too-small；`12–17` 隐藏 Header 或 Footer 的次要部分并缩短菜单窗口；`>=18` 使用正常布局。布局函数必须使用 clamp 后的非负整数。

### 9.4 欢迎页

Timeline 为空且没有 pending Interaction 时显示简洁欢迎页：Harness 名称/版本、工作区 basename、模型、Build/Compose、输入提示和不超过三个常用入口。禁止大幅 ASCII Logo、动态 Feed、营销内容和与当前功能无关的状态墙。

## 10. Overlay、Interaction 与 Web Handoff

### 10.1 OverlayView

Workspace、Status、BTW、Inspect、Tool Inspector 和文件预览共享一个覆盖视图骨架：标题、主体、可选 Footer。Overlay 拥有自己的滚动和按键，Esc 回到此前 Timeline anchor；关闭不得清空 draft 或切换 follow-tail。

### 10.2 Interaction

Approval、Directory Trust、Question、Plan、Goal 共享 BottomArea shell，但正文按风险语义区分：

- 文件 mutation 优先显示 operation、path、`+N/-M` 与有界 diff；
- Shell 优先显示命令与副作用提示；
- Directory Trust 显示工具、目标、待信任目录与遮蔽风险；
- Question 显示进度、多选状态和 custom input；
- Plan / Goal 保持内容预览、反馈输入和已确认的决策集合。

Interaction 的 options 必须来自现有 policy；视觉层不得增加、删除、重排安全决策或自动选择默认答案。

### 10.3 Web Handoff

进入 Web 接管后，TerminalSession 保持有效，全屏显示单一 handoff 状态页并冻结 Timeline 投影；返回时复用原 TuiAdapter、draft 和 Thread 状态重新布局。Web handoff 不创建第二个 TerminalSession，不把 alternate screen 控制权交给 Browser。

Ctrl+C / Esc 请求返回 TUI 的现有语义保持不变；CLI 终止仍由根 `finally` 恢复终端。

## 11. 状态、不变量与错误语义

### 11.1 不变量

1. 任一时刻只有一个 TerminalSession、一个 TimelineViewport 和一个 BottomArea owner。
2. 所有终端控制码只由 `terminal-session` implementation 输出。
3. Projection 不修改 Timeline，不 dispatch intent，不读取文件或环境。
4. 滚动、展开、菜单和覆盖视图是 Presentation 状态，不进入 Transcript、Protocol 或 SQLite。
5. 颜色永远不是状态的唯一表达。
6. 完成历史不包含持续 animation；只有活动项可以随 timer 变化。
7. 任何 resize、菜单或 Interaction 变化都不能丢失 draft、选中项或当前审批请求。
8. 退出恢复失败不能掩盖原始运行错误；诊断写 stderr，不污染 JSON-RPC stdout。

### 11.2 错误语义

- alternate screen 进入失败：逆序恢复已完成步骤，输出简短可操作错误并终止交互启动；不得静默回退旧 Renderer。
- 鼠标报告不可用：记录一次诊断并保留键盘滚动；不因可选滚轮能力使整个 TUI 不可用。
- terminal size 不可用：显示 too-small 状态并等待 resize；无法订阅 resize 时允许用户退出。
- Projection/Markdown 单条解析失败：降级为有界纯文本，只影响该条目。
- React render error：ErrorBoundary 显示最小错误并允许退出；根 finally 最终恢复终端。
- 恢复步骤失败：继续执行其余恢复步骤并保留首个恢复错误作为诊断，不能在第一步失败后放弃恢复。

## 12. Code Style 与 Interface 约束

新增生产文件遵循仓库中文说明、公开 interface 中文 JSDoc 和邻近 TypeScript ESM 风格。纯 Module 返回数据，不直接写 stream；adapter 接受依赖，不在内部读取全局 `process.stdin/stdout`，便于 fake stream 测试。

推荐形状：

```ts
/** 把纯展示条目投影到给定高度，并返回稳定 anchor。 */
export function layoutViewport(
  entries: readonly FullscreenEntry[],
  state: ViewportState,
  size: ViewportSize,
): ViewportLayout {
  // implementation hides wrap、cell width、anchor 与 follow-tail 细节
}
```

禁止：

- React 组件各自读取 `stdout.columns/rows` 并计算一套断点；
- 多个 effect 分别进入/退出 alternate screen 或鼠标模式；
- 为单个 Renderer 建立 factory、driver hierarchy 或通用 terminal framework；
- 在 `TuiAdapter` 新增 `scroll-up`、`mouse-wheel` 等纯像素 intent；
- 用 snapshot 测试替代所有状态/生命周期断言，或因视觉重构删除现有行为测试。

## 13. Testing Strategy

### 13.1 纯测试

- `fullscreen-projection`：消息类型、中文标签、Tool Group 边界、失败/运行中不合并、详情 id 保留、Markdown 降级。
- `timeline-viewport`：page up/down、顶部/底部、follow-tail、新内容计数、resize anchor、BottomArea 高度变化、空/单条/超长 Thread。
- 响应式：40、72、120 列与 12/17/24 行，所有尺寸为非负，优先级隐藏确定。
- Unicode：中文、emoji、组合字符、宽字符路径与长命令按 cell width 截断和换行。

### 13.2 TerminalSession adapter 测试

使用 fake stdin/stdout 与控制序列 recorder 覆盖：

- 成功 enter/close 顺序；
- 每个进入步骤失败后的逆序恢复；
- close 幂等、重复信号、部分 enter；
- resize 与 wheel 解码；
- 畸形/部分 mouse sequence 不进入 InputBuffer；
- non-TTY 不输出 alternate-screen 控制码。

### 13.3 Ink 帧与集成测试

- `renderToString` 或等价 harness 产生 40/72/120 列代表帧，覆盖欢迎页、普通对话、流式活动、Tool Group、审批、Question、菜单、Overlay、too-small。
- 真实 Ink mount 覆盖 Timeline 更新时 InputBar 固定、滚离底部不抢 anchor、恢复尾随、Interaction 与输入互斥、Web handoff freeze/return。
- fake timers 证明只有活动项动画，完成历史帧不随时间变化。

帧断言优先检查结构、行数、顺序、可见文案和 ANSI 语义，不对终端近似后的精确 RGB 做脆弱快照。

### 13.4 回归与人工验收

自动化至少运行 focused TUI、CLI package tests、typecheck、build、project:check。实机验收至少覆盖 macOS/Linux 可用终端中的：进入、resize、键盘滚动、鼠标滚轮、终端选择、Ctrl+C 三段行为、正常退出、SIGTERM、Web handoff 返回。

PR 或 Task 证据必须包含 40/72/120 列截图或录屏，展示相同会话在三种宽度下的降级，而不是只提供首页截图。

## 14. Boundaries

### Always

- 复用现有 Interactive Core、TuiAdapter、InputBuffer 和 `presentation-shared` 语义。
- 所有终端进入路径都有同一恢复路径；任何非平凡布局/滚动逻辑先写失败测试。
- 视觉状态同时具有 glyph/文案，不依赖颜色；菜单和 Interaction 保持键盘可达。
- 更新 TUI 架构和用户交互文档，删除被本任务取代的 canonical 描述。

### Ask first

- 新增任何 npm 依赖或修改已锁定版本。
- 修改现有快捷键、Interaction 决策、Protocol、Interactive snapshot 数据形状或 Web 行为。
- 放宽最小终端尺寸、恢复常驻 Sidebar、鼠标点击或自动复制。

### Never

- 回退 OpenTUI/Bun 或维护全屏/主屏双实现。
- 把滚动、终端控制码或 React node 放进 TuiAdapter/Interactive Core。
- 为视觉测试调用真实模型、提交凭据或访问公网资源。
- 通过删掉失败测试、隐藏错误或吞掉终端恢复失败来满足验收。

## 15. Success Criteria

1. Task 的 12 项可观察验收全部有自动化或实机证据。
2. 全屏 TUI 是唯一交互式入口；旧 `Static`/scrollback presentation 和对应死代码删除，不保留 alias/fallback。
3. `TerminalSession`、`FullscreenProjection`、`TimelineViewport` 的 Interface 小而稳定，复杂度不散落到每个 Ink 组件。
4. 40/72/120 列和短终端帧可读，历史滚动、尾随暂停、resize anchor 与终端恢复具有确定性测试。
5. 现有交互式能力和 Web handoff focused suites 无回归，Web/Protocol/Agent 生产代码无范围外修改。
6. `TUI表现层.md` 与 `架构总览.md` 描述 Node/npm/Ink 全屏路径；用户文档说明滚动、退出与复制限制。
7. 用户完成每个 Plan 可演示停点的实机查看；最终 Review 结论写回 Task 后才能完成归档。

## 16. Open Questions

无。若实现证明 Ink 6.8.0 无法在不新增依赖的情况下安全接收鼠标滚轮，或终端原生选择与所需鼠标模式不可兼容，必须停止实施并把事实、可选降级和依赖方案回写本节，由用户重新决定。
