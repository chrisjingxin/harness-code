# Project 协作视觉预览

2026-11-12，配合[桌面前端交互设计](../../architecture/桌面前端交互设计.md)评审。预览源码保留在仓库，不替换已有设计稿或正式桌面入口。

正式前端任务已登记为 HC-217～220，均待认领，职责与并行接点见[任务衔接](../../project/项目协作设计任务衔接.md#3-前端任务与并行顺序)。本预览只作交互和视觉对照，不表示这些任务已实现。

## 查看

在仓库根目录按顺序运行，使用已有根 npm workspace 依赖，无需新增服务或账号：

```sh
npm run build --workspace @workbench/ui
node node_modules/vite/bin/vite.js build --config docs/developer/previews/project-collaboration/vite.config.mjs
python3 -m http.server 57841 --bind 127.0.0.1 --directory tmp/project-collaboration-design
```

打开 <http://127.0.0.1:57841/>。构建产物位于已忽略的 `tmp/`；修改源码后重新构建并刷新页面。浏览器页签的顶部场景切换栏仅用于评审，不属于产品导航。

## 场景与边界

| 场景 | 可查看的交互 |
| --- | --- |
| 本机会话 | 既有头像、用户图标、消息、工具展开、输入区；右侧文件及中央可关闭文件页签 |
| 远端只读 | 默认只显示简报和未同步状态；点击同步才展示示例正文；没有发送、审批或远端文件入口 |
| 任务详情 | 接收与在本机开始分别操作；后者先选择工作目录，不因接收而自动执行 |
| 项目看板 | 成员进展与任务概览；点击会话进入相应本机或只读页面 |

左侧还提供 Project 资料、新建会话、团队知识及居中设置的布局示意。新建会话的目录初始为空，通过“选择文件夹”主动指定；普通非 Git 文件夹也有示例。同账号另一台电脑上的会话也按跨机器只读展示。

主题、字体、`BrandMark`、`ConversationView`、Markdown、高亮、`ProjectDock`、`ProjectFilePanel`、`ProjectFileTab` 和响应式 `WorkbenchLayout` 均使用 `@workbench/ui` 的公共出口。新增外壳样式只消费现有主题变量，不改中间对话或文件部件的生产实现。Git 写入入口在本稿隐藏。

所有人物、目录、仓库、消息、任务和同步时间均为固定示例。按钮只切换预览状态：同步不会联网，发送不会调用 Agent，任务不会发布给其他用户，目录选择不会读取本机文件。此稿没有实现或修改服务端、Runner 核心、数据库或 ACP，也不代表正式业务已经接通。真实系统的状态词、权限和可用动作以同事交付为准。

## 必要检查

```sh
node node_modules/typescript/bin/tsc -p docs/developer/previews/project-collaboration/tsconfig.json
node node_modules/vite/bin/vite.js build --config docs/developer/previews/project-collaboration/vite.config.mjs
```

预览是单独构建的评审材料，不加入正式产品 workspace、任务状态或生产打包入口。正式实施仍需确认视觉后按 Task / Spec / Plan / Todo 推进。
