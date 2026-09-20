# TUI 表现层

本文是 Harness Code TUI 视觉与渲染的长期架构入口。行为细节以对应 Task / Spec 为准；架构结论直接在此维护。

当前实施任务：[HC-183 全屏 TUI 视觉重构](../task/HC-183-全屏TUI视觉重构.md)（前置：[HC-182 Node与Ink运行时迁移](../task/HC-182-Node与Ink运行时迁移.md)）。

## 1. 架构定位与依赖关系

```text
InteractiveController（领域模型与业务状态事实）
        │
        ├─ TuiAdapter（本地 Presentation snapshot 与 Intent 派发）
        │       │
        │       ├─ FullscreenProjection（纯函数：Timeline 语义分组、折叠与文案纯投影）
        │       ├─ TimelineViewport（纯状态：可见窗口、按页/滚轮滚动、跟随与新内容计数）
        │       └─ FullscreenApp（Ink 6.8.0 / React 19 组件树）
        │               │
        │               └─ TerminalSession（唯一终端控制所有者：alternate screen、鼠标、光标与恢复）
        │
        └─ Web Adapter / Web Presentation（独立原生 Web 渲染器，互不共享组件树）
```

- **职责边界**：TUI 表现层只消费 snapshot 并派发 Intent；像素、滚动、窗口、终端控制码均属于 TUI 表现层私有状态，不进入 `InteractiveController`、Protocol 或 SQLite。
- **技术基准**：Node.js `>=20`、npm `10.9.3`、Ink `6.8.0`、React `19.2.6`，不依赖 OpenTUI 或 Bun。
- **术语规范**：底部交互区域统称 **输入栏（`InputBar`）**，严禁称作 Composer，避免与 Compose 工作模式混淆。

## 2. 页面骨架与槽位不变量

交互式 TUI 唯一采用全屏 alternate-screen 模式，退出后恢复原 Shell，不保留主屏滚屏 fallback。

全屏根布局占用终端 `stdout.columns × stdout.rows`，从上至下固定为四个槽位：

```text
┌────────────────────────────────────────────────────────┐
│ Header             0 或 1 行；极短终端可隐藏           │
├────────────────────────────────────────────────────────┤
│ TimelineViewport   占据全部剩余高度；唯一主滚动 owner  │
│ （或 OverlayView） （打开覆盖视图时在内容层替换视口）  │
├────────────────────────────────────────────────────────┤
│ BottomArea         InputBar / Interaction / Menu       │
├────────────────────────────────────────────────────────┤
│ Footer             0 或 1 行；按终端宽度与高度自适应   │
└────────────────────────────────────────────────────────┘
```

- **Header**：单行上下文，按优先级展示 Harness 标识/会话标题、工作模式、模型短名、工作区目录。
- **TimelineViewport**：应用内历史视口，支持 `PageUp`/`PageDown`、`Ctrl+Home`/`Ctrl+End` 与鼠标滚轮浏览历史。
- **BottomArea**：单 owner 互斥槽位（未决 Interaction 优先展示 InteractionShell；其次展示命令/补全菜单；常态展示 InputBar）。
- **Footer**：单行状态栏，展示活动状态、审批模式、输入模式与连接状态。
- **OverlayView**：覆盖视图（工作区、状态、BTW、Inspect、Tool Inspector 以及 Web 接管提示）在内容层替换 TimelineViewport，不创建平行终端窗口或重复挂载 Header/Footer。

## 3. 终端生命周期与恢复（`TerminalSession`）

`TerminalSession` 是唯一的终端控制序列所有者：
- **进入（enter）**：切换 alternate screen、清屏、隐藏/交接光标、启用最小鼠标滚轮上报、注册 resize 与退出信号；记录完成步骤以保证失败时严格逆序回滚。
- **退出与恢复（close）**：恢复鼠标模式、光标、raw mode、退出 alternate screen、清理监听器；恢复操作完全幂等。
- **统一异常兜底**：正常退出、Ctrl+C、SIGINT、SIGTERM、sidecar 退出与 React ErrorBoundary 均由根 `finally` 调用同一恢复路径。
- **鼠标与复制安全**：仅解析离散 wheel up/down，不接管点击或 hover，不持有系统剪贴板；文本复制完全依赖终端原生选区机制。

## 4. 纯投影与时间线层级（`FullscreenProjection`）

Core 时间线先经由纯函数投影为语义条目，再交由 Ink 渲染：

```text
TimelineItem[]
  → projectFullscreenTimeline()
  → FullscreenEntry[] (User / Assistant / Reasoning / Tool / ToolGroup / InteractionResult / Compose / Goal)
  → layoutViewport()
  → Ink Components
```

- **去除内部日志化标签**：不再输出 `You:`、`Harness:`、`Tool:`、`Reasoning:` 等 raw 枚举前缀。
- **用户消息**：中性文字主体，左侧带对应 Run 工作模式的强调 gutter。
- **Assistant 正文**：作为视觉主体，纯投影终端 Markdown（支持标题、强调、代码块、列表、引用、链接与表格；窄屏或超宽单元格纵向降级，内容不截断）。
- **工具活动收敛（Tool Activity Group）**：连续、同 run 且已完成的只读工具（`read_file`、`grep`、`glob`、`ls`）自动合并为折叠摘要；写入、删除、Shell、子代理、失败工具保持独立，且保留原始 Tool 身份用于详情查看。
- **局部流式反馈**：仅当前运行中的思考或工具行显示固定宽活动 Spinner，完成的历史完全静止，不产生多余重绘。

## 5. 交互面板与覆盖视图统一（`InteractionShell` / `OverlayShell`）

- **统一 InteractionShell**：Approval、Directory Trust、Question、Plan、Goal 共享一致的强边界外壳、标题、描述、选项列表与 Footer 快捷提示。
  - 文件变更优先显示操作类型、路径、行数变化与有界 Diff；
  - Shell 优先展示命令详情与副作用提示；
  - 目录信任明确警示工作区遮蔽风险；
  - 决策选项严格与共享 policy 对齐，不发明或重排安全选项。
- **统一 OverlayShell**：Workspace 文件树、Status、BTW、Inspect、Tool Inspector 共享统一标题、主体和关闭路径（Esc 返回，不丢弃草稿）。
- **统一选项样式**：所有选项列表统一使用 `❯ ` 与 `selection` 高亮色加粗，不使用裸 inverse。

## 6. 视觉语言与响应式门禁

- **唯一 Token 源**：色值仅从 `packages/cli/src/tui/presentation/theme.ts`（`tuiTheme`）读取，禁止生产组件散落裸颜色名。
- **模式色与语义色正交**：
  - Mode 色：Build `#EAB308`，Compose `#A9A5D4`；
  - Semantic 色：成功 `#7FA37A`、警告 `#C88758`、危险 `#C56F6F`、Diff `#6F9A72` / `#B96A6A`。
- **响应式等级**：
  - `too-small`（`<40` 列 或 `<12` 行）：全屏展示尺寸过小告警与退出提示，尺寸达标后原地恢复；
  - `compact`（`40–59` 列）：Header/Footer 隐藏次要字段，表格纵向降级，长单行窗口化；
  - `standard`（`60–99` 列）：标准完整体验；
  - `wide`（`>=100` 列）：增加参数与上下文可见量，仍保持单列布局，不恢复常驻 Sidebar。

## 7. 代码与目录结构

| 职责 | 文件位置 |
| --- | --- |
| 终端生命周期与恢复 | `packages/cli/src/tui/ink/terminal-session.ts` |
| 时间线纯投影与工具分组 | `packages/cli/src/tui/ink/fullscreen-projection.ts` |
| 视口滚动与 Anchor 计算 | `packages/cli/src/tui/ink/timeline-viewport.ts` |
| 全屏外壳与响应式槽位 | `packages/cli/src/tui/ink/fullscreen-shell.tsx` |
| 终端 Markdown 纯排版 | `packages/cli/src/tui/ink/terminal-markdown.ts` |
| 底部交互面板与 InteractionShell | `packages/cli/src/tui/ink/bottom-area.tsx` |
| 覆盖视图与 OverlayShell | `packages/cli/src/tui/ink/temporary-view.tsx` |
| 内联菜单与选择器 | `packages/cli/src/tui/ink/menus.tsx` |
| 根应用入口与键盘路由 | `packages/cli/src/tui/ink/app.tsx` |
| 主题 Token 唯一事实源 | `packages/cli/src/tui/presentation/theme.ts` |
