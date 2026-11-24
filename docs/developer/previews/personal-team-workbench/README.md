# 个人与团队协同工作台交互原型（方案 B · 已过期）

> **状态：已过期（2026-11-24）**
> 本目录的方案 B（单层纵向侧栏）交互原型已标记为**已过期**，最新正式交互原型已切换为 [个人与团队协同工作台交互原型（双层导航 · collaboration-workbench）](../collaboration-workbench/README.md)。本目录仅保留作历史归档对照（供已交付的 `HC-239`、`HC-246` 等历史文档回溯链接使用），后续新增功能与 UI 改造一律以新版原型为准。

本目录迁自 Open Design `c4-personal-team-workbench/layout-b-vertical.html`（方案 B：单层纵向侧栏），已拆分为标准 Vite 前端工程，原用于 [个人与团队协同用户旅程](../../architecture/个人与团队协同用户旅程.md)（`HC-233`、`HC-239`～`HC-254`）早期桌面前端开发的 UI 视觉与交互对照，**不进入正式桌面应用或服务端生产打包**。

## 本地运行与构建

在仓库根目录直接使用已有的 Vite 依赖运行，无需额外安装或启动后端：

```sh
# 启动本地开发预览服务（默认 http://127.0.0.1:57842/）
npm run preview:personal-team

# 仅执行生产静态产物构建（输出至 tmp/personal-team-workbench-preview）
npm run build:personal-team-preview
```

构建产物与 Vite 缓存均输出在仓库已忽略的 `tmp/` 目录下。

## 目录结构

| 文件 / 目录 | 说明 |
| --- | --- |
| `index.html` | 页面骨架、SVG Sprite 图标集、`#app` 容器与全部 `<dialog>` 弹窗模板 |
| `vite.config.mjs` | 独立 Vite 配置（复用根 `node_modules/vite`，监听 `127.0.0.1:57842`） |
| `src/main.js` | ESM 入口，按原层叠顺序导入三份 CSS 并启动原型脚本 |
| `src/app.js` | 完整交互状态机与本地示例数据（已移除指向失效对比稿 `layout-a-rail.html` 的顶栏外链） |
| `src/styles/primitives.css` | `OD-LAYOUT-PRIMITIVES v1`（`@layer od-layout` 结构层原语，必须首个加载） |
| `src/styles/workbench.css` | 工作台设计令牌（浅/深色、紫/蓝/青/墨强调色、密度、布局与组件样式） |
| `src/styles/layout-b-vertical.css` | 方案 B 单层纵向侧栏与视觉覆盖样式 |
| `public/assets/avatars/` | 示例成员头像静态资源（`*.jpg`） |

## 覆盖的交互场景

- **左栏双轨与个人优先会话**：常驻“我的会话”（含无团队/团队内个人会话、发布到 Project 与停止共享）、多 Workspace 切换、团队成员角色视角切换（管理员 / 开发者 / 未加入团队）。
- **全局与协作入口**：全局待办收件箱（Inbox）、全局命令面板（`Cmd+K`）、Project 导航/看板/Task 派发与“在本机开始”、跨机只读会话主动同步与异步批注。
- **团队知识与系统地图**：规约/经验/术语分级、适用范围匹配、提议与管理员审核流、团队系统地图拓扑与仓库关系、本机 `team.md` / `personal.md` 记忆演示。
- **右侧本机工具栏与外观设置**：本机文件树、Git 变更/历史视图、浅色/深色主题、强调色、界面密度与缩放设置。
