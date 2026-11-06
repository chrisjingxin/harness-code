---
id: HC-197
title: 通用ACP运行时
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待认领
owner: 未认领
branch: -
scope: 建立独立 acp-runtime，复用官方 SDK 管理本机 stdio 子进程、会话/能力、流式通知、审批/提问、取消、异常与恢复。
acceptance: mock ACP 与选定真实第二后端沿同一通用接口工作；不依赖 Harness/Python/旧 CLI，缺失能力不伪造，崩溃与取消只有真实终态。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md 与 docs/user/安全与沙箱.md；当前不新增产品运行承诺
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md；后续按本 Task 同名文件补 Spec、Plan、Todo
test_evidence: -
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-197 通用ACP运行时

## 需求与交付

以同一 ACP Client 生命周期运行不同 Agent。通用层能够建立/恢复会话、接收流式工具消息、取消及转交人工问题，无需理解 Harness 的内部对象。

属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md)，共同边界以 [独立桌面总体设计](../architecture/多人协作工作台顶层设计.md) 为准，参考来源见 [Lody 对照](../research/192-Lody协作能力对照.md)。设计基线为本地提交 `0250561`。本文是待审阅的子 Task，不是已确认 Spec 或实施计划，尚未认领或实现。

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

可与云端、设备、项目服务和 UI 任务并行；通过受控真子进程/mock ACP 验证本包，不在 UI 识别 Harness 结构，也不重写 HC-206 工具卡。根出口和通用扩展注册等共享文件由统筹顺序集成，见[并行开发约定](../project/协作任务并行开发约定.md)。

## 验收结果

- [ ] 没有 Harness/Python 时可以直接启动独立 mock ACP 子进程，完成建立会话、输入、流式通知和唯一终态。
- [ ] 真实 Claude/Codex 等选定第二后端沿同一路径互通；需要平台特定运行环境时记录范围，不用 mock 代替真实接通。
- [ ] 能力按握手提供，不支持恢复/图片/专有扩展时明确不可用，不按 Agent 名称推断。
- [ ] 取消、人工回答、子进程异常、畸形帧与连接关闭可收敛，等待模型或审批不阻塞协议接收。
- [ ] 原生会话 ID 对平台保持不透明，历史回放不再次当新消息追加，不暴露 Harness Thread/Run 类型。
- [ ] stderr 扩展订阅有明确进程和会话归属，通用运行时不识别 marker/Span 或直接读内核数据库。
- [ ] 执行设备的进程树终止与退出有实际确认；Windows/macOS 行为分别验证，不能把发出信号当成功停止。

## 验证与后续流程

用真实子进程边界和 mock Agent 覆盖成功/异常/取消/恢复，另为选定第二 Agent 记录真实互通；不使用真实模型密钥做自动化测试。

本 Task 确认后先写同名 Spec；Spec 确认后写 Plan/Todo，并按可演示停点实施。继续遵守用户跳过 Skill 调用的要求，不因生成任务而直接写生产代码、认领分支或改变其他任务状态。当前只有任务文档，未运行上述产品验收。
