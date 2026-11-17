# HC-221 工作台原型 UI 对齐 — 可执行清单

[Task](../task/HC-221-工作台原型UI对齐.md) · [Spec](../spec/HC-221-工作台原型UI对齐.md) · [Plan](../plan/HC-221-工作台原型UI对齐.md)。每完成一个停点即停下，说明查看方式并等待确认。

## 停点 1：全局视觉令牌、外壳与导航设置

查看方式：运行 `npm run dev`（正式桌面）或 `npm --workspace @workbench/desktop run preview:navigation`（受控导航预览），切换浅色/深色主题、收放左栏并打开设置弹窗查看效果。

- [x] 对齐 `packages/workbench-ui/src/theme/colors.css` 浅/深色板、冷紫强调色与 `--elev-*` 阴影令牌（保证 `generate-native-theme.mjs` 校验通过）。
- [x] 更新 `packages/workbench-ui/src/theme/base.css` 与 `packages/workbench-ui/src/common/common.css`，对齐字号/圆角/按钮体系并补充 `.wb-seg`、`.wb-status-badge`、`.wb-kbd`。
- [x] 更新 `packages/workbench-ui/src/layout/index.tsx` 与 `layout.css`，对齐顶栏双行主副标题、激活态开关、2px 悬停高亮拖拽线与弹窗样式。
- [x] 更新 `packages/workbench-ui/src/navigation/index.tsx` 与 `navigation.css`，对齐原型稿左栏结构（眉题、主按钮、搜索框与 `⌘K`、2px 紫线选中态、圆点同步标记与底部账号栏），保持 `ProjectNavigationProps` 零改动。
- [x] 更新 `apps/desktop/src/renderer/desktop-workbench.tsx`、`desktop-workbench.css`、`identity/identity.css` 与 `device-registration/device-registration.css`，美化设置弹窗外观/缩放分段控制及空态页。
- [x] **检查与验证**：`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm --workspace @workbench/desktop run build:navigation-preview`、`npm run test:project`、`npm run project:check`。到达后停下汇报。
- 记录（2026-11-16）：已从 `harness_lody` 切出 `feat_hc_221_工作台原型UI对齐` 并完成 HC-221 认领与停点 1 全部改造；`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm --workspace @workbench/desktop run build:navigation-preview`、`npm run test:project`（18/18）与 `npm run project:check` 均通过。

## 原型 UI 重做增量（2026-11-17）

- [x] 回退 `packages/workbench-ui/src/conversation/*`、`local-session-page.tsx`、`new-session-page.tsx`、`session-center.tsx` 及 `session.css` 会话区样式至 `harness_lody`，确保中央 Agent 对话区域不动。
- [x] 重做 `@workbench/ui` 主题令牌（4 强调色 + 3 密度）、全高左栏与 56px 顶栏外壳、原型左栏导航（Workspace/团队知识库/Project/看板/任务/新建/⌘K 搜索/我的会话）、右栏 Git 工作区与提交记录子视图及暂缓态栏。
- [x] 新建 `apps/desktop/src/renderer/features/collaboration-views/` 接入顶栏协作成员浮层、`⌘K` 命令面板、四列看板、任务列表与详情、团队知识库、引用与派发弹窗及 Toast。
- [x] 重做 `ProjectInfoPage`、`CreateProjectDialog`、`WindowPreferences`（强调色/密度/快捷键）、跨机只读简报卡片样式及 `ProjectWorkbench` 全局快捷键。
- [x] **验证与缺口统计**：执行全套构建、类型检查、依赖边界、预览构建与自动化测试，整理 Java 与 Python 服务端缺口清单。
