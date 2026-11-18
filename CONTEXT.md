# Harness Workbench 领域词汇

本文是独立桌面协作工作台、ACP 多代理接入层与可选 Harness Python ACP Agent 内核共用的领域词汇表；代码、契约与文档应保持一致命名，不再沿用已退役的旧 CLI/TUI/`Handoff`/`Interactive Core` 术语。

## 1. 协作工作台与桌面平台术语

| 术语 | 定义 | 不包含 |
| --- | --- | --- |
| Workspace | 真实团队协作边界；聚合团队成员、项目（Project）、团队知识与轻量通知流。 | 本机文件目录、Git 仓库。 |
| Project | Workspace 内的协作事项，关联参与成员、会话列表、Task、看板及可选仓库元数据。 | 本机工作目录（cwd）。 |
| Session（协作会话） | Project 内发布的对话记录，在原用户的原设备绑定一个本机工作目录运行；跨机器访问（含同账号其他设备）统一只读，由查看者主动同步正文。 | 跨机器远程命令执行、实时远端文件读取。 |
| Task（产品任务） | Project 内向成员显式发布的协作任务，支持关联固定引用快照并由接收者在本机主动选择目录与 Agent 开始。 | 工程研发看板卡片（`HC-XXX`）。 |
| 轻量通知（SSE） | Java 协作服务向桌面推送的简报、Task 或知识元数据变更通知；只触发元数据刷新，不自动下载正文或启动 Agent。 | 正文消息流、下行控制命令。 |
| `LocalAcpHost` | `@workbench/acp-runtime` 提供的标准 ACP 宿主封装，管理本机 Agent 子进程启动、会话绑定、提示发送、流式事件与交互请求。 | 特定 Agent 内部模型循环、云端账号体系。 |
| Provider（代理提供方） | 实现本机 ACP 接入描述符的可插拔 Agent 实例（如 `harness`、`pi`、`qwen` 或 `custom`）。 | 平台核心启动前置依赖。 |

## 2. 可选 Harness Python Agent 内核术语（`packages/agent`）

| 术语 | 定义 | 不包含 |
| --- | --- | --- |
| Agent Core | 执行模型循环、工具中间件、上下文压缩与子代理委派的 Python 领域模块。 | 桌面 UI、Electron IPC、云端协作业务。 |
| Agent Host | 一个工作区范围内承载 Core、`ThreadPersistence`、`AgentEnginePool`、配置、Skill、MCP 与 `RunCoordinator` 的 Python 进程（经 `harness-agent acp` 暴露）。 | 多项目共享守护进程、桌面窗口管理。 |
| Thread | Python 内核本地 SQLite 中持久化的对话事实（`harness_threads` / `harness_thread_transcript`）。 | 云端 Project 协作会话实体。 |
| Run | Thread 上的一次 Agent 执行周期，同一 Thread 最多存在一个活动 Run。 | 外部客户端连接生命周期。 |
| RunContextSnapshot | 顶层 Run 准备阶段冻结的不可变系统上下文快照（包含策略、AGENTS 与 Skill 索引）。 | 长期对话消息正文。 |

> 说明：原旧 CLI/TUI/Web 架构中的 `Interactive Core` / `InteractiveController`、`Interactive Adapter`、`PresentationCoordinator`、`WebUiGateway` 与 `Handoff` 已随 `HC-203` 退役，仅作历史归档文档追溯词汇保留。
