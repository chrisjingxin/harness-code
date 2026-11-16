---
id: HC-197
title: 通用ACP运行时
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待验收
owner: 用户（本机）
branch: harness_lody
scope: 建立独立 acp-runtime，复用官方 SDK 管理本机 stdio 子进程、会话/能力、流式通知、审批/提问、取消、异常与恢复。
acceptance: mock ACP 与选定真实第二后端沿同一通用接口工作；不依赖 Harness/Python/旧 CLI，缺失能力不伪造，崩溃与取消只有真实终态。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md 与 docs/user/安全与沙箱.md；当前不新增产品运行承诺
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md；docs/developer/project/协作任务并行开发约定.md；docs/developer/spec/HC-197-通用ACP运行时.md；docs/developer/plan/HC-197-通用ACP运行时.md；docs/developer/todo/HC-197-通用ACP运行时.md
test_evidence: 2026-11-16 macOS x64 三个停点通过必要冒烟。正式双 Electron 通过审批、停止、唯一成功上传与 B 主动同步，真实 Harness 恢复和真实 Qwen Code 流式通过，详见结果。
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-197 通用ACP运行时

## 当前协作安排（2026-11-16）

用户确认 HC-197 此前未由同事实施，现由用户（本机）负责，沿用 `harness_lody`。优先完成本地发送首轮。从受信任的 Electron 主进程入口绑定本人本机的会话和已选目录，启动 HC-200 交付的 Agent，观测发送受理、分段正文、终态及同会话再次发送。正式桌面消费由 HC-218 接线。见[并行开发约定第 0 节](../project/协作任务并行开发约定.md#0-当前调度hc-197-本机首轮2026-11-16)。

上次在 `6a8cb94` 核对了远端和本机产物，`acp-runtime` 只有包骨架。HC-200 已验证用官方 Python 客户端直连 Agent 进程，作为实施前的协议基线。

## 需求与交付

以同一 ACP Client 生命周期运行不同 Agent。通用层能够建立/恢复会话、接收流式工具消息、取消及转交人工问题，无需理解 Harness 的内部对象。

属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md)，共同边界以 [独立桌面总体设计](../architecture/多人协作工作台顶层设计.md) 为准，参考来源见 [Lody 对照](../research/192-Lody协作能力对照.md)。设计基线为本地提交 `0250561`。本次实施以同名 Spec、Plan 与 Todo 中的三个停点为准。

## 范围与目标归属

- packages/acp-runtime 与 workbench-contracts：标准 SDK 接线、子进程/会话生命周期和通用执行事件映射。
- 能力协商、原生会话绑定、恢复/历史回放去重与必要的执行事件端口。
- 人工请求、取消和协议接收互不阻塞；受控 stderr 订阅只作为扩展端口。
- Runner 执行端口与可选集成注册边界，具体接口/SDK 固定版本在本任务 Spec 评审。

## 依赖与范围边界

代码前置为 [HC-193](./HC-193-独立桌面工程与分包.md) 工程与 [HC-194](./HC-194-协作契约与云端基础.md) 已确认/可消费的基础契约，不要求 Java 全部业务完成。与 HC-195/196/200 先确认执行事件/生命周期交界后，可独立开发 ACP 包；真实同会话接续在 Runner/Agent 接通后另验。

不重写 ACP 编解码或模型循环，不通过旧 CLI/JSON-RPC 模拟 ACP。不解析 Harness Trace marker，不增加自动跨 Agent 检查点转换；Harness Agent 适配归 HC-200。

## 并行认领与接口交付

本任务主责 acp-runtime 和通用执行事件映射，供 HC-196 执行器调用、HC-200 Agent 适配对接、HC-201 扩展订阅；执行状态、原生绑定、恢复回放和取消/人工请求的交界先写 Spec/共同夹具。平台 wire schema 的会话与设备域分别由 HC-195/196 主责，不各自复制一份消息类型。

HC-197 负责首轮本机宿主，HC-218 消费这一入口。通用包使用标准 SDK 和不透明的原生会话 ID。共享 main/preload 出口由统筹安排串行集成。

## 验收结果

- [x] 没有 Harness/Python 时可以直接启动独立 mock ACP 子进程，完成建立会话、输入、流式通知和唯一终态。
- [x] 真实 Qwen Code 0.17.0 沿同一路径建立会话、发送并接收完整流，模型端使用回环服务。
- [x] 能力按握手提供，不支持恢复/图片/专有扩展时明确不可用，不按 Agent 名称推断。
- [x] 取消、人工回答、子进程异常、畸形帧与连接关闭可收敛，等待模型或审批不阻塞协议接收。
- [x] 原生会话 ID 对平台保持不透明，历史回放不再次当新消息追加，不暴露 Harness Thread/Run 类型。
- [x] stderr 扩展订阅有明确进程和会话归属，通用运行时不识别 marker/Span 或直接读内核数据库。
- [ ] 执行设备的进程树终止与退出有实际确认；Windows/macOS 行为分别验证，不能把发出信号当成功停止。

## 验证与后续流程

用真实子进程边界和 mock Agent 覆盖成功/异常/取消/恢复，另为选定第二 Agent 记录真实互通；不使用真实模型密钥做自动化测试。

各停点只做受影响的构建、类型、依赖边界及必要主路径冒烟。Windows 与完整异常矩阵留 HC-204。

## 停点一结果（2026-11-16，待验收）

- `@workbench/acp-runtime` 使用官方 Node ACP SDK 0.25.1。Electron 主进程入口 `createDesktopLocalAcpHost` 按可信启动配置建立宿主；详细输入、事件和释放方法见 [Spec](../spec/HC-197-通用ACP运行时.md#主进程接线与本机复现)。
- 在 macOS x64 从这个主进程模块启动 HC-200 的真实 Harness，并通过隔离 HOME 读取已有用户级模型配置。首轮受理 `cfaa30ff-9088-4b03-8fc6-49b930aaef9b`，收到 `1 Hello → 2 ! → 3 completed`，终态后发送恢复可用，宿主确认子进程退出。真实网关首次连接失败，Harness 重试后完成。临时 HOME 保留独立测试历史。
- 真实 Harness 配合回环模型完成三轮。前两轮使用同一会话，第三轮使用另一账号和目录的会话，分别收到三个顺序正文增量和唯一终态。验证忙时拒绝重复提交、换绑不同目录拒绝、事件隔离、结束后允许再次发送。另用不存在的执行路径验证启动失败只发一个终态，并允许显式重试。
- `@workbench/acp-runtime` 与 `@workbench/desktop` 的构建和类型检查通过，依赖边界及主进程限制负例通过。
- HC-218 下一步在正式 Electron 的会话和目录授权后绑定句柄，经具名 IPC 转发状态与事件。取消、审批、原生恢复、第二 Agent、Windows 和完整回归留后续。本卡仍进行中。

统筹已核对主进程入口、执行事件类型和本机冒烟日志。首个运行时停点通过复核，已交 HC-218 接入正式桌面。

## 后续停点安排

用户已确认依序实施两项。停点二接入停止与标准工具审批，等待 Agent 返回本轮实际结果。停点三在同账号、同设备、同会话与原目录恢复原生 Agent 会话，用 Harness、独立 ACP 测试进程和第二个真实 Agent 验证。Windows 和完整回归留 HC-204。

### 停点二 停止与人工审批

2026-11-16，macOS x64 两个正式 Electron、Java 21 和 MySQL 8.4 冒烟通过。A 在真实 Harness 中拒绝工具，临时目录无对应文件。A 在输出第一段文字后停止，收到唯一取消终态。A 再发送，并通过桌面审批卡选择「允许一次」和「提交」，工具写入测试文件，工具卡完成并收到两段正文及唯一成功终态。Java 仅收到一次正式 sync（HTTP 200，水位 2），测试补传关闭。B 点击前历史请求为 0，点击主动同步后只读收到一对定稿消息。模型使用隔离回环服务，联调证据 `/tmp/hc218-live.qVk8Wp/evidence.json`。命令使用现有 `scripts/workbench/run-dual-desktop-smoke.sh`，准备 HC-218 所列变量，再设置 `HC197_SMOKE_ACTIONS=1`。

### 停点三 原生会话恢复与通用性

- 同一个正式双桌面脚本关闭并重启 A，重新登录、进入原会话并确认原目录。新模型请求含第一次成功发送的文本，本轮界面只收到两个新的文本增量和一个终态。恢复本身未提交历史，Java 新增一次正式 sync，正文水位从 2 到 4。证据见同一 JSON 的 `resume`。
- 用正式 Harness 和回环模型在同一账号、设备、会话和目录完成一轮，关闭宿主和子进程，再启动宿主发送下一轮。第二次模型请求同时包含前后两条唯一测试输入，当前轮只收到本次的两个增量与完成。原生会话 ID 留在本机绑定目录。日志 `/tmp/hc197-followup-harness.log`。
- 真实 `/usr/local/bin/qwen --acp`（Qwen Code 0.17.0）在同一宿主入口完成初始化、建会话、发输入、两段正文和成功终态。模型端使用本机 OpenAI 兼容回环服务。日志 `/tmp/hc197-followup-qwen.log`。
- 独立 Node ACP 子进程验证批准、拒绝、过期回答、取消后重发、进程崩溃、畸形帧、恢复回放隔离与每轮唯一终态。通过 stderr 诊断定位父子 PID，验证同一 macOS 进程组均退出。Windows 子进程树、脱离进程组的工具、真实网关恢复、第二 Agent 的恢复及完整异常回归仍待验。
- 相关工作区构建、类型、依赖边界、任务和文档检查通过。本机没有 OpenWiki 命令，生成页待刷新。服务端、Runner 核心和 HC-201 专有 Trace 由各自任务维护。
