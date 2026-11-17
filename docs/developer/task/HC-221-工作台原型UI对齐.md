---
id: HC-221
title: 工作台原型UI对齐
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: 张景新
priority: P1
status: 待验收
owner: 张景新
branch: feat_hc_221_工作台原型UI对齐
scope: 对照新版 Open Design 工作台原型稿对桌面工作台外壳、全高左侧边栏、56px 顶栏、协作成员浮层、⌘K 命令面板、Project 看板、任务双栏页、团队知识库、项目资料与成员、跨机只读简报页、右侧文件/Git 面板及系统设置弹窗完成架构与视觉重做；严格保留现有中央 Agent 对话区域（conversation 组件与 local/new/center 会话区）暂不改动，并盘点 Java 协作服务与 Python/ACP 宿主能力缺口。
acceptance: 工作台布局外壳、浅深主题+4 强调色+3 密度、左栏 Workspace/Project/知识库/看板/任务/我的会话结构、顶栏协作成员浮层、⌘K 命令面板、看板与任务/知识库交互视图、项目资料与成员弹窗、跨机只读简报卡、右栏工作区/提交记录切换与产品暂缓态及设置弹窗均对齐原型稿；中央 Agent 对话区保持原样无回归；全部构建、类型检查、依赖边界检查、预览构建与单元测试通过。
user_docs: 不涉及（UI 结构与视觉重做，后续联网与后端补齐后统一更新用户手册）
developer_docs: docs/developer/spec/HC-221-工作台原型UI对齐.md；docs/developer/plan/HC-221-工作台原型UI对齐.md；docs/developer/todo/HC-221-工作台原型UI对齐.md；docs/developer/architecture/桌面前端交互设计.md
test_evidence: 待本次最终验证后写入（2026-11-17 重做版）。
references: docs/developer/task/HC-217-项目导航与资料.md；docs/developer/task/HC-218-会话只读与主动同步.md；docs/developer/task/HC-192-协作工作台与会话交接.md
completed_at: -
---

# HC-221 工作台原型 UI 对齐

## 要解决的问题

桌面工作台已完成 HC-217 与 HC-218 的核心功能链路，但当前渲染界面的色彩层级、细环阴影、顶栏上下文、左栏导航视觉、设置弹窗表单、项目资料双栏卡片、对话流卡片/输入区以及中央文件分屏与右侧变更筛选视图仍沿用早期样式，与最新确认的工作台视觉原型稿（位于 `/Users/zhangjingxin/Library/Application Support/Open Design/namespaces/release-stable/data/projects/c3-harness-code-workbench-v3/index.html`）存在明显差距。

本任务目标是在**不调整任何业务功能、不改宿主/后端接口、不新增业务状态机**的前提下，仅通过调整 UI（设计令牌、组件 DOM 展示结构、CSS 样式与纯视图本地状态），让现有已落地的全部桌面功能对齐原型稿体验。

## 本卡负责（2026-11-17 按原型稿整体重做版）

1. **主题令牌、强调色与密度体系（`@workbench/ui/theme`）**：对齐原型稿语义令牌（`--sidebar`、`--fg`、`--fg-2`、`--meta`、`--border*`、`--warn*`、`--toast-*`、`--scrim`），并新增 4 种强调色（`violet` / `indigo` / `teal` / `ink`）与 3 档界面密度（`compact` / `standard` / `wide`），保留 `generate-native-theme.mjs` 单块 6 位 hex 不变量。
2. **全高左侧边栏 + 56px 顶栏外壳（`@workbench/ui/layout` & `navigation`）**：重构为通顶左栏 + 右侧主区结构；左栏按原型重建 Workspace 切换器、团队知识库入口、分隔线、Project 切换器、项目看板、任务待办徽章、`+ 新建会话`、`搜索 ⌘K`、`我的会话` 自有列表及底部账号设置栏；顶栏新增返回按钮槽、`headerExtra`（协作成员叠放头像按钮）与主题切换键。
3. **全局浮层与协作页面（`apps/desktop/src/renderer/features/collaboration-views`）**：1:1 复刻顶栏 560px 双栏协作成员与队友会话浮层、⌘K 全局命令面板、Project 四列看板、任务双栏（筛选/认领/在本机开始弹窗/标记完成/@成员派发弹窗）、双层团队知识库（Workspace 规约与 Project 沉淀、新建弹窗、内联编辑自动递增版本号、@ 引用进草稿）及全局 Toast。后端 Task/Knowledge 接口上线前由 `collab-store.ts`（`localStorage` 持久化）承接并在验收后按缺口清单接入 HC-212。
4. **项目资料、设置弹窗、跨机简报与右栏 Git（`project-navigation`、`desktop-workbench`、`project`、`session.css`）**：重做 `ProjectInfoPage` 与 `CreateProjectDialog`（含初始成员勾选并在创建后串行邀请）；`WindowPreferences` 接入强调色/密度与 2×2 快捷键网格；跨机简报卡片对齐原型 `.brief-card` / `.ro-strip` / `.peer-foot-inner`；右栏 `ProjectGitPanel` 支持「工作区 | 提交记录」子页签与产品暂缓态紧凑提交条。
5. **明确冻结边界**：根据用户要求，**中央 Agent 对话区域本次保持原样不改**（`packages/workbench-ui/src/conversation/*`、`local-session-page.tsx`、`new-session-page.tsx`、`session-center.tsx` 及对应会话/新建样式），留待后续整体重做 UI。

## 缺口清单归属

Java 协作服务（HC-212 任务/知识/快照/看板聚合/用户级 SSE、Workspace 成员角色、项目一步创建、Agent 摘要）与 Python ACP / Electron 本机宿主（非纯文本 prompt 上下文、工具 `tool_summary` 上报、Agent 摘要/标题、`image=False`、`gitLog` 提交历史）缺口见 [Spec §4](../spec/HC-221-工作台原型UI对齐.md#4-后端与宿主能力缺口清单) 与最终交付报告。

## 验收标准

- [x] 全高左侧边栏、56px 顶栏、协作成员浮层、⌘K 命令面板、看板、任务、团队知识库、项目资料、新建弹窗与设置弹窗已按原型稿重做完成。
- [x] 中央 Agent 对话区域（`conversation/*`、`local-session-page.tsx`、`new-session-page.tsx`、`session-center.tsx`）保持 `harness_lody` 原样未改动。
- [x] `npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`bun test apps/desktop/tests/`、`npm run test:project` 与 `npm run project:check` 全部通过。
