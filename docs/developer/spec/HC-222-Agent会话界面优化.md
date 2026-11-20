# HC-222 Agent会话界面优化 Spec

[Task](../task/HC-222-Agent会话界面优化.md) · [Plan](../plan/HC-222-Agent会话界面优化.md) · [Todo](../todo/HC-222-Agent会话界面优化.md)

## 1. 现状与改后收益

| 现在 | 改后 |
| --- | --- |
| 人和 Agent 都靠左、都带头像，正文缩进 34px | 用户靠右成气泡，回复靠左通栏，正文无头像和独立名称栏 |
| 每个工具独占 30px 一行，失败整行红底 | 28px 紧凑日志行；连续工具合成一组，结束后收起；失败只染图标并加徽标 |
| 推理是紫色色块，结束后直接消失 | 推理是一行灰色“思考过程”，本轮结束自动折叠，可以再展开 |
| 运行状态孤立在时间线最底部 | 状态行跟在当前这一轮的末尾 |
| 长会话只能手动滚动找 | 左侧锚点条按提问排列，悬停预览，点击跳转 |
| 强调色在三个文件各写一份 | workbench-ui 提供唯一出口，设置页引用它 |
| 几乎没有动效 | 有一处重点动效（一轮结束时过程折叠），其余是轻量的状态反馈 |

## 2. 不变量（实现时不能破坏）

1. `ConversationViewProps`、`ConversationTimelineEntry`、`ConversationPersonalState` 等公开类型不变；不新增必填字段。
2. 发送、停止、审批提交、草稿条件清空这几条链路不改（`view.tsx` 的状态机不动）。
3. 滚动锚点的保存、恢复和“跟随最新输出”语义不变。新增的“跳到某条提问”算用户主动滚动，会退出跟随。
4. 个人展开状态只用现有的 `expandedTools` / `expandedOutputs` 字符串列表。新增的键只有两种：工具组 `group:<首个工具 id>`；推理沿用推理条目自身的 id。
5. 所有颜色只用语义变量。成功、提醒、危险三类状态色不随强调色变化。
6. 不新增依赖，动效全部用 CSS 过渡/关键帧和少量 DOM API 实现。
7. `colors.css` 的浅色/深色块仍然各只有一组 `--bg`、`--text` 六位色值，保证 `generate-native-theme.mjs` 继续通过。

## 3. 分区规格

### 3.1 强调色公共出口（`packages/workbench-ui/src/theme/`）

- 新增 `accent.ts`，并从根入口导出：
  ```ts
  export const ACCENT_OPTIONS: readonly { id: "violet" | "indigo" | "teal" | "ink"; label: string; swatch: { light: string; dark: string } }[]
  export type AccentId = (typeof ACCENT_OPTIONS)[number]["id"]
  export const DEFAULT_ACCENT: AccentId // "violet"
  export function isAccentId(value: unknown): value is AccentId
  ```
- 新增 `accent.css`，由 `theme.css` 在 `colors.css` 之后、`base.css` 之前引入。
  - 每种强调色在浅色、深色下只定义三个值：`--accent`、`--accent-hover`、`--accent-fg`。
  - 未设置 `data-accent` 时按紫罗兰处理。
- 衍生变量统一从 `--accent` 计算，不再写死色值：
  - `--accent-text` 与 `--action-text` 取 `var(--accent-fg)`；`--action` 取 `var(--accent)`；`--action-hover` 取 `var(--accent-hover)`。
  - `--accent-tint` 用 `color-mix(... var(--accent) 6%/12%, transparent)` 计算（浅色 6%，深色 12%）。
  - `--accent-soft`、`--accent-border` 等保持现有的 color-mix 写法。
- 删除 `colors.css` 中的 `--brand` 以及写死的强调色值，删除 `base.css` 中 `[data-accent]` 那 8 组定义。
- `desktop-workbench.tsx` 删除本地的 `ACCENT_OPTIONS`，改为引用公共出口：读取存储值时用 `isAccentId` 校验，色块显示当前主题对应的 `swatch`。设置界面不变。
- 验收检索：在 `packages/`、`apps/` 中搜 `#5b63d3`、`#8c93f8`、`91, 99, 211`、`140, 147, 248`，只允许出现在 `accent.ts` 和 `accent.css`。

### 3.2 消息版面（`timeline.tsx`、`conversation.css`）

- 时间线不再渲染头像。`RoleAvatar` 仍保留导出，hc205 预览还在用。
- **用户消息**
  - 整条靠右，内容最宽 `min(82%, 560px)`。
  - 悬停或聚焦时，气泡右下方显示复制图标和消息时间。
  - 气泡：底色 `--surface`，加 `inset 0 0 0 1px var(--border)` 细边，圆角 `12px 12px 4px 12px`。
  - 文字 `--text-md`，行高 1.7，保留换行。
- **Agent 组**
  - 正文与工具左对齐，正文最宽 660px。
- **回复底栏**
  - 只有回答已结束、有文字、且宿主提供 `rendering.copyText` 时才出现。
  - 内容：复制图标按钮（28×28）。
  - 显隐：鼠标悬停该组或组内有焦点时淡入；`(pointer: coarse)` 下一直显示。
  - 复制成功后图标换成对勾，用 `--success-text` 色，1.2s 后复原；同时通过 `aria-live` 播报“已复制”，失败时播报原因。
- 系统消息改为居中的小药丸：`--text-2xs`、`--surface-2` 底色。
- 流式光标改为 2px 宽的强调色竖线，透明度做 1s 的缓动闪烁。
- 代码块（`rendering.css` 的 `.code-block*`）保留现有高亮链路，只调外观：
  - 圆角 `--radius-md`，底色 `--surface-2`，加细边。
  - 头部显示语言（等宽 `--text-2xs`）和复制按钮。复制按钮在悬停或聚焦时可见，触屏下一直可见。
- 本文件改动涉及的字号一律改用 `--text-*` 变量。

### 3.3 工具日志行与分组（`tool-card.tsx`、新增 `timeline-model.ts`）

- **单行结构**：`[图标 14px] [名称] [摘要] [徽标] [箭头]`，最小高度 28px，左右内边距 6px，悬停时显示 `--hover` 底色。
  - 名称：`--text-xs`、500 字重、`--fg-2`。
  - 摘要：等宽 `--text-xs`、`--muted`。摘要像路径时（含 `/`、没有空白）拆成“目录 + 文件名”：目录部分可以省略号截断，文件名完整显示，颜色用 `--fg-2`。
- **状态**
  - 运行中：12px 旋转图标。
  - 完成：不额外加标记，保持安静。
  - 失败：图标改用 `--danger-text` 色，并显示“失败”徽标（`--danger-tint` 底、`--danger-text` 字，等宽 `--text-2xs`）。不再整行红底。
- **箭头**：改为向右的 ChevronRight，展开时旋转 90°（`--motion-fast`）。没有 `onToggle` 时不显示箭头，按钮不可点。
- **详情区**：左侧 1.5px `--border` 竖线，缩进与图标中线对齐；展开时淡入并下移 2px（180ms）。参数、输出这两块卡片的结构不变。
- **分组规则**：在 `timeline-model.ts` 写纯函数 `segmentAgentEntries(entries)`。
  - 规则：同一 Agent 组里连续 ≥2 个工具合成 `{ kind: "tool-group", key: "group:<首个 id>", tools }`，其他条目原样保留。
  - 组头：图标 + “N 个操作” + 失败数（“· 1 个失败”，用危险色字）+ 箭头。
  - 有工具在运行时：组头显示旋转图标与“正在执行 · 第 N 个”，组体强制展开，不能收起；组体内滚动自动贴底，除非用户在组内向上滚过。
  - 全部结束后：按 `expandedTools.includes(key)` 决定，默认收起。
  - 组体：左侧 1.5px 竖线，最高 `min(18rem, 50vh)`，组内滚动。内容溢出时用 `mask-image` 在上下两端做 16px 渐隐；滚到顶或底时取消对应一端的渐隐。

### 3.4 思考过程与自动折叠（`timeline.tsx`）

- 推理条目不再在结束后过滤掉，改为渲染成可折叠的一行：
  - 标题：brain 图标 +“思考中”（进行中）或“思考过程”（已结束）+ 箭头。
  - 正文：`--text-soft`，`--text-sm`，左侧竖线，保留换行。
- 一轮“进行中”指以下任一成立：推理 `active`；同组里有 `streaming` 的回答；同组里有运行中的工具；该组是最后一组且 `activity.active`。
- 展开规则：
  - 进行中：默认展开。用户这时点收起，只记在组件本地状态，这一轮结束后失效。
  - 已结束：按 `expandedTools.includes(推理 id)` 决定，默认收起。点击时写入个人状态。
- 工具组和推理共用同一个折叠容器 `Disclosure`。它的组体始终挂载，用 `grid-template-rows: 0fr ↔ 1fr` 配合透明度做过渡；收起时组体设为 `inert` 并对读屏隐藏。

### 3.5 运行状态与交互（`timeline.tsx`、`interaction.tsx`）

- **运行状态行**
  - 当最后一组是 Agent 组时，状态行渲染在该组末尾；否则（例如刚发完提问）渲染为一个只含名称行和状态行的 Agent 组占位。
  - 文案沿用现有 label、phase 和已运行时长。
  - 进行中时标签带一道文字微光（`mask-image` 扫光，2.2s 一轮）；页面隐藏或组件离开视口时暂停。
- **待处理请求区**
  - 边框改成 1px 提醒色细边：`color-mix(in srgb, var(--warn) 45%, var(--border))`。去掉 3px 左边线，标题前加提醒色图标，背景用 `--surface`。
  - 出现时上移 8px 并淡入（240ms）。
- **已处理交互**：改为一行“图标 · 标题 · 状态文字”。`statusLabel` 只是文字，没有语义类型，所以状态一律用 `--muted` 显示（缺口见第 4 节）。
- **回到底部按钮**
  - 改为悬浮药丸：向下箭头 + 文案，`--elev-raised` 阴影；出现时上移 6px 并淡入。
  - 有新输出时文案换成“有新输出”，边框用强调色，按钮内显示一个强调色圆点。

### 3.6 左侧会话锚定（新增 `timeline-minimap.tsx`）

参考样式：一列竖排短横线刻度，悬停某个刻度浮出深色卡片，上方一行小时间（如“14:16”）下方是用户提问原文（可多行）；点击刻度锚定滚动到该提问。

- **数据**：纯函数 `deriveMinimapItems(entries)`，每条 `role === "user"` 的消息产出一项 `{ entryId, text, createdAtMs? }`。`text` 为合并空白后的提问原文，数据层不截断（由 CSS 限制行数）；空白提问跳过。预览只展示提问本身，不再携带回答摘要。
- **显示条件**
  - 至少 2 项。
  - 对话容器宽度 ≥980px：容器 `.wb-conversation` 设为 `container-type: inline-size`，用容器查询判断。
  - `(pointer: fine)`。
  - ≥980px 时刻度列不遮挡消息内容（正文列居中、上限约 740px）。
- **布局**
  - 定位在 `.wb-conversation` 左侧 12px、垂直居中；刻度列超过容器 60% 高度时列内滚动。
  - 不设上一条/下一条按钮，只有刻度列。
  - 所有刻度右对齐到同一条竖边。每个刻度是一个按钮：
    - 默认：12×2.5px，`--meta` 色，透明度 0.55。
    - 悬停或聚焦：18px、`--fg-2`。
    - 当前项：24×3px、`--accent`。
    - 宽度变化走 `--motion-fast` 过渡。
- **当前项判定**：滚动时（用 rAF 节流）取“顶部已越过视口上 1/3 处”的最后一条提问；都没越过时取第一条。
- **预览浮层**
  - 全局共用一个浮层元素，定位在悬停/聚焦刻度的垂直中线，向刻度列右侧展开。
  - 反色卡片：亮色主题 `background: var(--fg)`、`color: var(--bg)`；暗色主题 `background: var(--surface-3)`、`color: var(--fg)`，外圈 1px `var(--border)`。
  - 宽 280px、圆角 10px、内边距 10px 12px、`--elev-pop` 阴影。
  - 内容：一行小时间 `--text-2xs` 弱化色（HH:mm，无 `createdAtMs` 时不渲染该行），下方提问 `--text-sm`，最多 6 行截断，空白已合并。
  - 动效：淡入并右移 4px（150ms）；`pointer-events: none`；减少动态效果时只做透明度淡入。
  - 无障碍：浮层 `role="tooltip"`，当前活跃刻度用 `aria-describedby` 指向它。
- **跳转**
  - 由 `useTimelineScroll` 新增的 `scrollToEntry(id)` 完成：平滑滚到目标条目位于视口约四分之一处的位置，退出跟随（视同一次用户上滚：显示回到底部按钮、按用户滚动回写个人位置）。
  - 到达后目标提问气泡带 `data-anchor-flash` 1.4s：强调色外环淡出；减少动态效果时改为静态描边 1.4s，不做动画。
- **键盘**
  - 刻度列用 roving tabindex：只有焦点项可 Tab 聚焦，方向键上下移动焦点（同时显示预览），Home/End 到首尾，Enter 或空格跳转。
  - 无障碍：整体是 `nav`，aria-label 为“提问锚点”；每个刻度的 aria-label 为“跳到提问：<前 40 字>”。

### 3.7 动效规格

| 场景 | 作用 | 做法 | 时长 / 曲线 |
| --- | --- | --- | --- |
| 重点：一轮结束，过程折叠 | 让人看清“过程收起，答案留下” | 推理与工具组的组体从 `1fr` 收到 `0fr` 并淡出；组头文案从“思考中 / 正在执行”交叉淡入成“思考过程 / N 个操作” | 320ms，`--ease-out-expo` |
| 新条目进入 | 提示有新内容到达 | 只对挂载之后新出现的条目播放；历史加载和恢复时不播。用户气泡从右下方 6px 处、回答从下方 4px 处淡入 | 220ms，`--ease-out-expo` |
| 展开 / 收起 | 说明层级关系 | 箭头旋转；组体走 grid-rows 过渡；工具详情区淡入 | 140–200ms |
| 运行中 | 表示仍在工作 | 文字扫光、旋转图标 | 2.2s 循环，离开视口时暂停 |
| 锚点跳转 | 保持位置连续，让人知道跳到了哪 | 平滑滚动，目标气泡外环淡出 | 1.4s |
| 反馈 | 确认操作已生效 | 复制对勾、回到底部按钮出现、请求区上移淡入 | 150–240ms |

- 在 `base.css` 增加两个变量：`--motion-slow: 320ms`、`--ease-out-expo: cubic-bezier(.16, 1, .3, 1)`。
- `prefers-reduced-motion: reduce` 下：去掉所有位移、扫光和旋转；平滑滚动改为直接跳转；保留透明度与颜色变化（时长缩到 120ms）；折叠改为瞬时切换。

## 4. 数据缺口（交给对应卡片，不在本卡补）

| 缺口 | 影响 | 承接 |
| --- | --- | --- |
| 本机会话转换未产出推理条目 | 真实会话里看不到思考折叠，只能在夹具里验证 | HC-218 / HC-197 |
| 工具与推理没有耗时字段 | 不显示“用时 X” | HC-218 |
| 已处理交互没有结果类型 | 状态文字无法按允许/拒绝着色 | HC-218 |
| 回复没有模型名、本轮改动文件汇总 | 不显示模型标签和改动文件卡片 | HC-218 / HC-212 |

## 5. 验证

- `npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`。
- `npm --workspace @workbench/desktop run build:conversation-preview` 与 `build:session-preview`。
- 用 hc206 会话预览截图，检查以下组合：
  - 浅色 / 深色；
  - 1280 / 980 / 760 宽度；
  - 系统“减少动态效果”；
  - 4 种强调色。
- 对 `packages/workbench-ui/src/conversation` 运行一次 `impeccable detect --json`。

## 6. 2026-11-17 会话阅读补充

- 文件树、文件页签和消息中可识别的文件名复用同一类型图标；未知类型使用普通文件图标。文件名识别只影响外观，不改变读取权限。
- 回到底部按钮只显示箭头；有新内容时保留描边和圆点，并提供无障碍名称。
- 中央与右侧打开 Markdown 默认显示排版，可分别切换为带行号的源码。预览消费已有文件内容，复用安全 Markdown 渲染，不加载图片、相对链接、原始 HTML 或其他本机文件；图片显示替代文字。
- 浅色下行内代码从当前强调色与文字色混合得到较深颜色；深色下保持可读。源码和对话代码块共用提高对比度的浅／深语法色。
- 本人本机会话的消息内文件引用和工具详情中的路径可点击，复用原有文件预览；只有文件名时查询工作目录，同名或搜索不完整时展示候选供用户选择。明确路径必须位于当前工作目录，最终读取仍由本机宿主校验；跨机器会话不提供本机打开动作。

## 7. 完成轮次折叠行

- 用户消息和回复区域去掉独立名称栏。正在执行或等待审批的状态仍随当前轮展示。
- 完成轮次的思考与工具记录收成一行，有耗时则显示「Harness Code 用时 15s」，点击可展开。右侧完成时间在悬停或聚焦时显示，沿用用户消息的本机日期规则。
- 本地使用轮次终态与 Agent 的耗时。历史记录用已有的发送和完成时间计算耗时；缺少时间或 Agent 名称时省去对应信息。
