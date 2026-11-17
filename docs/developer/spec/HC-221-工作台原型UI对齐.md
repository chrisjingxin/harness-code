# HC-221 工作台原型 UI 对齐 Spec

状态：草稿，待评审。对应任务见 [HC-221 Task](../task/HC-221-工作台原型UI对齐.md)；实施步骤见 [HC-221 Plan](../plan/HC-221-工作台原型UI对齐.md)；执行清单见 [HC-221 Todo](../todo/HC-221-工作台原型UI对齐.md)。原型参考文件位于 `/Users/zhangjingxin/Library/Application Support/Open Design/namespaces/release-stable/data/projects/c3-harness-code-workbench-v3/index.html`。

## 1. 现状与改后收益

**现状痛点**：当前桌面端的公共 UI 令牌（`@workbench/ui`）和各业务页面（`apps/desktop`）沿用早期蓝色工作台改过来的过渡样式，边框偏硬、层次不够克制、左栏选中缺少 2px 强调竖线与紧凑同步点、设置弹窗仍使用原生下拉框、本机文件打开会遮挡整个对话区、右侧变更列表在文件较多时缺乏前端筛选和目录树聚合。

**解决思路**：在不修改任何后端接口、preload 通道、持久化数据模型和组件外部行为契约的基础上，分 3 个停点将原型稿的视觉体系（中性底色 + 细环阴影 + 精准冷紫强调 + 清晰信息层级）与纯前端界面微交互逐层落到 `@workbench/ui` 和 `apps/desktop/src/renderer/`。

**改后收益**：全部已交付功能在零功能回归风险下获得与最新原型稿一致的视觉品质、更清晰的读写隔离感与更高效的文件/变更浏览体验，同时为尚未接入的 HC-219 与 HC-220 预置统一的视觉样式基础。

## 2. 兼容性不变量（Hard Invariants）

所有 UI 改造必须同时满足以下自动化检查与冒烟约束：

1. **原生主题生成脚本兼容**（`scripts/workbench/generate-native-theme.mjs`）：
   - `packages/workbench-ui/src/theme/colors.css` 中 `:root[data-theme="light"]` 与 `:root[data-theme="dark"]` 块各只能出现 1 次。
   - 每个块内 `--bg` 与 `--text` 只能定义 1 次，且值必须是 6 位十六进制颜色（`#xxxxxx`）：
     - light：`--bg: #fafafa;`、`--text: #171717;`
     - dark：`--bg: #101013;`、`--text: #ededf0;`
2. **既有 CSS 变量向后兼容**：保留 `--brand`、`--bg`、`--surface`、`--surface-2`、`--surface-3`、`--field-bg`、`--line`、`--line-strong`、`--text`、`--text-soft`、`--muted`、`--subtle`、`--accent`、`--accent-hover`、`--accent-text`、`--accent-soft`、`--accent-soft-2`、`--accent-border`、`--accent-border-strong`、`--action`、`--action-hover`、`--action-text`、`--sidebar-bg`、`--message-user-bg`、`--thread-selected-bg`、`--overlay-scrim` 等现有语义变量名，避免尚未改造的预览页或扩展页失色。
3. **自动化冒烟选择器与文案兼容**（`scripts/workbench/smoke-dual-desktop.mjs`）：
   - 保留 `.desktop-empty button.wb-button-primary`、`.identity-panel select`、`.identity-panel button.primary`、`.collaboration-modal`、`button[aria-label="设置"]`、`[aria-label="关闭设置"]`、`选择目录并登记`、`[data-testid="device-state"]`。
   - 保留 `.pnav-project-switch`、`[role="menuitemradio"]`、`新对话`、`.pnav-member-toggle[aria-controls="pnav-member-..."]`、`.pnav-session[title="..."]`。
   - 保留 `.session-new-page`、`.session-new-controls button`、`.session-new-page textarea`、`.session-new-send button`、`.session-directory-button`、`.session-brief-text`、`同步会话`。
   - 保留 `.wb-composer-textarea`、`[aria-label="发送消息"]`、`[aria-label="取消当前任务"]`、`.wb-conversation-message-user`、`.wb-conversation-message-assistant`、`.wb-interaction-option-positive`、`.wb-interaction-option-negative`、`.wb-interaction-submit`。
4. **公共包导出与依赖边界**：仅在 `packages/workbench-ui` 内部与 `apps/desktop/src/renderer/` 内调整，不引入跨路径内部引用，保持 `npm run check:boundaries -- --self-check` 通过。

## 3. 分区规格

### 3.1 全局设计令牌与通用控件

- **字体与层级**：保留系统无衬线 + 等宽字体栈；补充字号变量 `--text-2xs`（11px）至 `--text-2xl`（24px）。
- **中性底色与细环阴影**：
  - Light：`--bg: #fafafa`、`--surface: #ffffff`、`--sidebar-bg: #f4f4f6`、`--surface-2: #f2f2f5`、`--rail-bg: #f7f7f9`、`--line: rgba(0, 0, 0, .09)`、`--line-soft: rgba(0, 0, 0, .05)`、`--line-strong: rgba(0, 0, 0, .16)`、`--selected: rgba(0, 0, 0, .06)`、`--hover: rgba(0, 0, 0, .038)`。
  - Dark：`--bg: #101013`、`--surface: #151519`、`--sidebar-bg: #141418`、`--surface-2: #1c1c22`、`--rail-bg: #121216`、`--line: rgba(255, 255, 255, .10)`、`--line-soft: rgba(255, 255, 255, .055)`、`--line-strong: rgba(255, 255, 255, .18)`、`--selected: rgba(255, 255, 255, .075)`、`--hover: rgba(255, 255, 255, .05)`。
  - 强调色：Light `--accent: #5b63d3`（Hover `#4d55c4`）；Dark `--accent: #8c93f8`（Hover `#a0a6fa`）。
  - 阴影令牌：`--elev-ring`、`--elev-raised`、`--elev-pop`。
- **公共控件**：`.wb-button`（高度 32px / 小号 28px，圆角 6px）、`.wb-icon-button`（30px）、`.wb-seg`（分段切换胶囊）、`.wb-status-badge`（状态胶囊）、`.wb-kbd`（等宽快捷键提示）。

### 3.2 外壳、顶栏与设置弹窗

- **顶栏**（`.collaboration-header`）：高度 52px~56px，背景 `var(--bg)`，底部 `inset 0 -1px 0 var(--line)`；上下文区域采用上下紧凑双行排布（标题 + 等宽/次要元信息），左右栏开关按钮在激活态带 `--selected` 底色；支持在不新增契约的情况下美化右侧分隔与标题栏拖动区。
- **拖拽线**：`.collaboration-left-resize` 与 `.project-dock-resize` 默认为 `1px` 细线，悬停或拖拽时显示 `2px` 强调色高亮线。
- **设置弹窗**（`.collaboration-modal` / `.desktop-settings`）：12px 圆角 + `--elev-pop` 阴影 + 标准弹窗头部与分隔线；外观（跟随系统/浅色/深色）与窗口缩放使用 `.wb-seg` 分段按钮组呈现，身份与本机设备登记区域按 `.set-section-title` + `.panel` 风格排版。

### 3.3 左侧 Project 导航栏

- 保持 `ProjectNavigationProps` 与交互契约完全不变。
- 顶部显示紧凑品牌与团队标识 + `PROJECT` 大写等宽眉题；项目切换按钮与设置图标按钮并行（`.pnav-project`），下拉菜单使用 `--elev-pop` 浮层样式。
- 项目工具入口（「看板」「任务」）与底部「团队知识」统一使用原型稿 `.nav-item` 视觉：30px 行高、选中态 `--selected` 底色与左侧 `2px` 强调色竖条、右侧胶囊计数。
- 「新对话」使用主色强调按钮视觉，搜索输入框采用白底 + `1px` 细环阴影样式（附带 `⌘K` 提示并支持 `⌘K`/`Ctrl+K` 聚焦搜索框）。
- 会话行（`.pnav-session`）改为双行紧凑布局（会话标题 + 圆点式同步状态 `.pnav-sync-mark` 与时间），选中态带左侧 `2px` 强调色竖条；其他成员分组置于底部并支持独立展开滚动。
- 底部账号栏（`.pnav-account`）采用顶部分隔细线 + 28px 头像 + 账号/团队名双行 + 右侧设置按钮。

### 3.4 项目资料页与创建项目弹窗（停点二）

- `ProjectInfoPage` 采用 `.page-head` + `.info-grid` 双栏卡片布局（左侧项目概况与关联仓库 `.panel`，右侧项目成员 `.panel`），编辑态使用 `.fld` 表单样式；
- `CreateProjectDialog` 对齐原型稿 `.dlg` 表单头部、输入字段与底部按钮栏样式。

### 3.5 跨机只读简报页与冻结边界

- `RemoteSessionPage` 与 `apps/desktop/src/renderer/features/session/session.css`：对齐跨机只读 `.session-remote-brief` 大卡片、`.session-brief-top`、`.session-ro-strip-wrap`、`.session-peer-foot-inner` 操作条与「← 返回我的会话」顶栏按钮；
- **中央 Agent 对话区域冻结**：严格保留 `packages/workbench-ui/src/conversation/*`、`apps/desktop/src/renderer/features/session/local-session-page.tsx`、`new-session-page.tsx`、`session-center.tsx` 及 `session.css` 中的会话/新建流样式与 DOM 结构，不在此轮修改。

### 3.6 协同交互视图与右栏 Git 面板

- `apps/desktop/src/renderer/features/collaboration-views/`：`TopbarCollabButton`、`CollabMembersPopover`、`CommandPaletteModal`（`⌘K`）、`ProjectBoardPage`、`ProjectTasksPage`（含 `StartTaskDialog` / `DispatchTaskDialog`）、`TeamKnowledgePage`（含 `KnowledgeCreateDialog`）与 `useCollabStore`；
- `ProjectDock` / `ProjectGitPanel`：新增「工作区 | 提交记录」子页签与产品暂缓态紧凑提示栏（`gitDeferred`），无真实 `gitLog` 时在「提交记录」诚实提示接口待接入，不伪造提交日志。

## 4. 后端与宿主能力缺口清单

- **Java 协作服务（`services/collaboration-server/`）**：缺少任务/知识/快照/看板聚合/用户级 SSE（对应 HC-212 尚未认领）、Workspace 成员角色字段、新建项目一步绑定初始成员与仓库接口，以及服务端 Agent 摘要生产链路。
- **Python ACP 与 Electron 本机宿主（`packages/agent/harness_agent/host/acp/server.py`、`packages/acp-runtime/src/session.ts`、`apps/desktop/src/main/`）**：本机 ACP 宿主尚未转发非纯文本上下文块（`@文件`/`@知识`）、模型/模式切换与工具完整 `tool_summary` 上传；Python 侧尚无协作任务/知识上下文感知及面向上传简报的 Agent 摘要事件（当前简报由 `conversation-uploads.ts` `briefExcerpt()` 规则截取），且 `PromptCapabilities.image` 为 `False`；本机只读目录宿主未暴露 Git 提交历史（`gitLog`）。
