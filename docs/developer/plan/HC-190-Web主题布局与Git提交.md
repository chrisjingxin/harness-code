# HC-190：Web主题布局与Git提交实施计划

来源：[Task](../task/HC-190-Web主题布局与Git提交.md) / [Spec](../spec/HC-190-Web主题布局与Git提交.md)。本次按用户授权跳过 Skill 调用，其余流程不变。

## WP1：独立主题与双主题生效

1. 修改 `tests/web/presentation/styles.test.ts`，增加独立主题来源、品牌派生、变量完备、暗色选中与对比度测试，先观察失败。
2. 把 `presentation/styles.css` 的颜色映射迁到 `theme.css`，由 `web/app.tsx` 显式导入；现有语义变量名称直接迁移，不维护双份色表。新增消息背景与 Thread 选中变量。
3. 将 `brand-logo.tsx` 的绿色常量改为主题变量，保留 SVG 结构；组件布局与工具交互不改。
4. 更新 Web 用户文档、架构主题边界和旧 HC-125 的覆盖关系。运行 focused presentation/application、typecheck、build、project:check；实际浏览器检查真实 Web 与双主题。

**停点 1**：真实 `/web` 变为白底冷紫、深色选中清晰，原有消息/头像/工具仍在；颜色集中在 `theme.css`。此时文件树仍在左侧，Git 仍只读。更新 Todo/交接后等用户查看。

## WP2：外围布局迁移

前置 WP1 验收。目标文件：`workspace-sidebar/{workspace-sidebar,thread-section,file-explorer}.tsx`、`context-dock/{context-dock,panel-common}.tsx`、`web-app.tsx`、`application/adapter.ts`、必要样式与对应 tests。

按 Spec 先写导航/文件共享状态测试，再迁移组件；保留所有既有配置面板，用统一设置入口访问。默认左栏 280px，图标同轴，纯色选中；新建与搜索轻量化；右栏文件树与代码预览共用真实状态；变更入口先明确展示待接入，真实 Git 状态/Diff 随 WP3 接入。现有 WorkspacePreview 只有文件内容，无 Git Diff 契约。验证拖动、文件打开、重连、忙碌、键盘与配置入口，不重写中间 Timeline。

**停点 2**：用户可以在真实 Web 右侧浏览文件及内容预览，左侧只显示会话；全部原有设置功能可达。验证 presentation/application 与 gateway 回归、typecheck/build/project:check，截图双主题。随后停下等待。

## WP3：勾选提交与推送

前置 WP2 验收。目标边界：`interactive/ports/` 工作区 Git 接口、`infrastructure/` Git 执行服务、共享 Controller/feature 状态、`presentation-coordinator/web-ui-gateway.ts` intent 路径、Web adapter/变更面板及对应 tests。

1. 临时 Git 仓库测试先行：仅选中文件、未选暂存保留、新增/删除/rename、部分暂存、特殊路径、冲突/子模块/过期快照、hooks/身份失败。
2. 实现结构化 preflight/status/commit/push 结果、服务端 busy/幂等与异常收敛；所有 Git 执行使用参数数组，执行结果脱敏且有界。
3. 接入 Web 选择/全选/消息/按钮；目标 upstream 与未推送提交数量可见，提交成功推送失败独立反馈和重试。
4. 使用本地 bare remote 验证推送成功、拒绝、超时、重试不重复提交；测试重复 request、过期 revision、非 active handoff、运行中禁止和重连恢复。

**停点 3**：在临时演示仓库实际勾选、提交、推送到本地 bare remote；不以主仓库或用户远端作为测试对象。focused 与工程检查通过后等用户验收；包级已存在断言失败及沙箱限制如实记录，不宣称全量通过。实际公网认证/网络超时、跨平台及最终闭环仍在 WP4 检视。

## WP4：Review 与闭环

对照验收矩阵检查全部既有 Web 功能、双主题与布局；运行 `npm run typecheck`、`npm run test`、`npm run project:check` 和构建。环境限制/历史失败与本任务回归分开记录；不以静态检查冒充浏览器验证。补齐用户/架构文档，用户最终验收后按 `task:complete` 归档。没有显式指令不提交、不推送、不新建分支。

## 停点 2 补充：按原稿对齐外观

按用户 2026-10-30 反馈修正 Command 品牌图标、顶部路径和面板开关、会话头、左下入口与连接状态、侧栏间距及右侧文件预览；保留中间交互，验证双主题和相关回归后交付浏览器。

## 设置交互调整（2026-11-02）

新增一个可演示停点：先写设置独立状态/分类记忆、单入口、能力门禁、键盘焦点和草稿保留回归；再拆分 Adapter 的 SettingsPanel 与 ContextDockPanel，新增 SettingsDialog 复用既有面板并迁移所有调用；同步主题变量样式与用户/架构文档。验证 Web application/presentation、typecheck/build/project:check，并在浏览器检查双主题、键盘关闭、右侧上下文保留。完成后交付用户查看，不提交、不推送。
