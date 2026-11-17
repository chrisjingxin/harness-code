# HC-221 工作台原型 UI 对齐：实施计划

状态：已完成原型结构与视觉重做，待验收。行为与接口约束见 [Spec](../spec/HC-221-工作台原型UI对齐.md)，范围与验收见 [Task](../task/HC-221-工作台原型UI对齐.md)，执行清单见 [Todo](../todo/HC-221-工作台原型UI对齐.md)。

## 1. 总体顺序

```text
阶段 1：全局视觉令牌（4 强调色 + 3 密度）+ 通顶左栏与 56px 顶栏外壳
   └─ colors.css / base.css / layout / navigation / desktop-workbench & settings
阶段 2：协同交互浮层与页面（协作成员 / ⌘K / 看板 / 任务 / 团队知识库）
   └─ apps/desktop/src/renderer/features/collaboration-views/ + project-workbench.tsx
阶段 3：项目资料、创建弹窗、跨机简报与右栏 Git（工作区 + 提交记录 + 暂缓态）
   └─ project-navigation / session.css / project dock / use-local-directory
阶段 4：严格保留中央 Agent 对话区域 + 盘点 Java/Python 能力缺口
   └─ conversation/*、local/new/center 会话页保持原样；交付完整缺口报告
```

## 2. 验证方式

- 构建与类型：`npm run build`、`npm run typecheck`
- 边界与脚本：`npm run check:boundaries -- --self-check`、`npm run test:project`、`npm run project:check`
- 预览与单测：`npm --workspace @workbench/desktop run build:{session,navigation,project,conversation}-preview`、`bun test apps/desktop/tests/`
