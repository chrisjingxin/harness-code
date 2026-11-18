# HC-222 Agent会话界面优化 — 可执行清单

[Task](../task/HC-222-Agent会话界面优化.md) · [Spec](../spec/HC-222-Agent会话界面优化.md) · [Plan](../plan/HC-222-Agent会话界面优化.md)。每完成一个停点即停下，说明查看方式并等待确认。

## 停点 1：强调色公共出口、消息版面与动效基础

查看方式：`npm --workspace @workbench/desktop run dev:conversation-preview` 打开会话预览；正式桌面 `npm run dev` → 设置 → 强调色切换。

- [x] 新增 `theme/accent.ts`（`ACCENT_OPTIONS`、`AccentId`、`DEFAULT_ACCENT`、`isAccentId`）并从根入口导出。
- [x] 新增 `theme/accent.css`，在 `theme.css` 中引入；删除 `colors.css` 的 `--brand` 和写死的强调色值、`base.css` 的 8 组 `[data-accent]` 定义；衍生变量改为由 `--accent` 计算。
- [x] `desktop-workbench.tsx` 改为引用公共强调色列表，色块按当前主题显示。
- [x] `base.css` 增加 `--motion-slow`、`--ease-out-expo`。
- [x] 时间线去头像：用户消息靠右气泡，上方显示“作者 · 时间”；Agent 组顶部显示“名称 · 时间”，正文取消缩进、最宽 660px。
- [x] Agent 回复底栏：悬停或聚焦时出现复制按钮，复制后显示对勾反馈。
- [x] 系统消息改为居中小药丸；流式光标改为 2px 强调色竖线。
- [x] 新条目进入动效（只对挂载后新出现的条目播放），并提供减少动态效果的替代。
- [x] 代码块外观对齐（语言标签、复制按钮、圆角细边）。
- [x] 本停点涉及的字号改用 `--text-*` 变量。
- [x] **检查与验证**：`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm --workspace @workbench/desktop run build:conversation-preview`；检索写死的紫色色值只剩公共强调色文件；预览截图（浅色 / 深色、1280 / 760、4 种强调色）。到达后停下汇报。
- 记录（2026-11-17）：`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm --workspace @workbench/desktop run build:conversation-preview` 通过；写死紫色检索只命中 `theme/accent.ts`、`theme/accent.css`；hc206 预览经 Electron CDP 截图（1280/760 × 浅/深、青碧、墨黑），复制按钮点击播报“已复制”，挂载后追加的消息带进场动效。推理块、请求区与已处理交互的粗侧边线留到停点 2 改造。

## 停点 2：工具日志与分组、思考自动折叠、状态与交互

查看方式：会话预览中查看工具组、失败工具、推理、待处理请求；切换系统“减少动态效果”再看一遍。

- [x] `timeline-model.ts`：`segmentAgentEntries`（连续 ≥2 个工具成组）与“一轮进行中”的判定。
- [x] 通用 `Disclosure` 折叠容器（grid-rows 过渡，收起时设为 inert）。
- [x] 工具日志行：28px 高，路径拆成目录与文件名，失败用徽标，箭头向右，详情区淡入。
- [x] 工具组：组头显示数量和失败数；运行中强制展开并在组内贴底滚动；上下端渐隐；结束后默认收起。
- [x] 思考过程：进行中展开，本轮结束自动折叠，手动展开写入个人状态。
- [x] 运行状态行归入当轮末尾，带扫光（离开视口时暂停）。
- [x] 待处理请求区改为提醒色细边加图标，出现时有动效；已处理交互改为一行。
- [x] 回到底部按钮改为悬浮药丸，有新输出时显示强调色描边和圆点。
- [x] 夹具补充：一轮“运行中的工具组 + 进行中推理”、一轮“已结束的推理 + 工具组 + 回答”。
- [x] **检查与验证**：同停点 1 的命令；截图覆盖浅色 / 深色、980 / 760、减少动态效果。到达后停下汇报。
- 记录（2026-11-17）：Part A 工具内容与思考接通（acp-runtime `tool-update.ts` 提取 input/output/diffs，`agent_thought_chunk` 经 `thought-delta` → 通知 → 推理条目，全程仅本机不上传）。Part B 停点 2：`timeline-model.ts` 分段与进行中判定（经 `@workbench/ui/timeline-model` 子路径导出供单测）、`Disclosure`、工具日志行与组、思考自动折叠、组内状态行与扫光、请求区提醒细边、历史交互单行、回到底部药丸均已实现；hc206/hc218 夹具补齐运行组+推理、结束轮（含 1 失败）、无内容工具与含差异工具。`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`build:conversation-preview`、`impeccable detect`（0 项）通过；node:test 19 项通过；Electron CDP 与 agent-desktop 截图/点击校验通过，截图存 `/tmp/hc222-stop2/`。

## 停点 3：左侧会话锚定

查看方式：会话预览中准备至少 4 条提问，把窗口拉宽到 ≥980px，看左侧锚点条。

- [x] `deriveMinimapItems` 纯函数（只产出提问折叠文本 + 时间，按用户要求去掉回答摘要）。
- [x] `useTimelineScroll.scrollToEntry(id)`：平滑跳转、退出跟随、目标气泡高亮。
- [x] `timeline-minimap.tsx`：刻度、当前项、提问预览浮层（按用户要求去掉上一条 / 下一条按钮）、roving tabindex 与方向键操作。
- [x] 容器宽度 <980px、提问少于 2 条或触屏时隐藏。
- [x] 本机会话的提问补上 `createdAtMs`，锚点预览能显示时间。
- [ ] **检查与验证**：同停点 1 的命令；对 conversation 目录运行 `impeccable detect --json`；冒烟正常路径；截图（1280 / 980 / 760、深色）。到达后停下汇报。

## 会话阅读补充（2026-11-17）

- [x] 文件树、页签和消息内文件名复用类型图标；回到底部按钮只显示箭头。
- [x] 中央／右侧 Markdown 支持预览与源码切换；复用已有安全渲染与文件内容。
- [x] 提高浅／深主题语法色对比度，行内代码颜色由当前强调色派生。
- [x] `npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`node --experimental-strip-types scripts/workbench/smoke-file-rendering.mjs` 通过；受控项目／会话预览中检查了双入口切换、浅／深色和箭头跳转。
- 限制：Markdown 图片显示替代文字，相对链接不打开；未扩展本机文件读取接口。原停点 3 的其余验收继续按原清单处理。
- [x] 本机会话中的文件引用与工具详情路径支持打开只读预览；同名选择与目录外拒绝已在受控会话中冒烟。
