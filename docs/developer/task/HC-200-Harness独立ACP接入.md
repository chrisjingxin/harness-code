---
id: HC-200
title: Harness独立ACP接入
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待认领
owner: 未认领
branch: -
scope: 在独立 Harness Agent 实现内提供 Python ACP 接入适配，复用现有运行/持久化服务，接入通用 Runner 并验证恢复与人工交互。
acceptance: 真实 Harness 经 ACP 可建会话、流式运行、取消/回答和恢复；平台不导入内核类型，切换到其他 Agent 无需 Harness/Python。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md 与 docs/user/安全与沙箱.md；当前不新增产品运行承诺
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md；后续按本 Task 同名文件补 Spec、Plan、Todo
test_evidence: -
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-200 Harness独立ACP接入

## 当前等待安排（2026-11-10）

本卡 ACP 适配的开发、接线、调试和验证整体等待同事完成 ACP 交付；暂只保留已有需求与调研材料。仅共同讨论接口不解除等待，不先实现 Python ACP 入口、mock 调试链路或旧协议旁路。见[当前并行约定](../project/协作任务并行开发约定.md#0-当前调度等待同事交付-acp2026-11-10)，本节覆盖下文接口确定后即可并行开发的原安排。

## 需求与交付

让 Harness 成为可独立运行的 ACP Agent，桌面使用它与使用其他 Agent 一样经由协议接入。共享业务留在平台，已有模型、工具和上下文能力留在内核。

属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md)，共同边界以 [独立桌面总体设计](../architecture/多人协作工作台顶层设计.md) 为准，参考来源见 [Lody 对照](../research/192-Lody协作能力对照.md)。设计基线为本地提交 `0250561`。本文是待审阅的子 Task，不是已确认 Spec 或实施计划，尚未认领或实现。

## 范围与目标归属

- 现 packages/agent 内的独立 ACP 入口与必要应用服务接合，具体路径在 Spec 固定。
- ACP 会话到内部 Thread/Run/Interaction 的映射，原生上下文和检查点由 Agent 自己维护。
- 进程启动配置和退出、恢复回放、通用能力声明与失败语义。
- 内网模型/SDK 差异留在 Agent 配置与能力声明，不改变平台公共协议。

## 依赖与范围边界

先等待同事完成 [HC-197](./HC-197-通用ACP运行时.md) 等 ACP 工作并交付代码，再共同核对 ACP 能力/生命周期/扩展交界，安排 Agent 包的独立适配；不以接口评审代替实际交付。届时不需等协作 UI 全部完成，真实 Runner 接入与跨用户原会话接续仍需 HC-197/196 对应停点，独立协议冒烟不能替代它们。

不把用户、设备、工作区、交接和 @引用业务加入 Python 内核；不模拟 TUI 输入，不经过旧 CLI 或把 JSON-RPC v3 改名成 ACP。不重写模型循环或交换其他 Agent 的私有检查点；Trace/专有设置的外层集成归 HC-201。

## 并行认领与接口交付

主责 Harness Python ACP 入口和必要内核适配，生产改动不进入通用 Runner/Java/UI。与 HC-197 共享协议进程场景，与 HC-201 明确 stderr/扩展归属和能力；Trace 解析与 UI 由 HC-201，不能两边采集同一日志。

同事 ACP 交付且本卡 Spec 审查后，才可与设备/项目/对话/导航及 HC-201 的解析/视图迁出并行开展本卡适配。内网包缺口保留原逻辑，测试结论按实际环境记录；共享装配由统筹协调，见[并行开发约定](../project/协作任务并行开发约定.md)。

## 验收结果

- [ ] 通用 acp-runtime 可启动实际 Python Harness ACP 进程，执行沿用内核唯一运行/终态与工具策略。
- [ ] ACP 建会话由 Agent 内部创建 Thread，对外只返回原生标识；平台和 Java 不读取 Harness SQLite/内部类型。
- [ ] 流式消息、工具、取消、审批/提问经协议接续，换查看用户或关闭窗口不会丢失原执行通道。
- [ ] 原设备在线时用户 B 接手仍沿用同一 Agent 原生上下文，重启后按宣告能力恢复，历史回放不重复。
- [ ] Agent 异常、取消、恢复失败和不支持能力明确反馈，不在云端再建一套模型循环兜底。
- [ ] 不安装或不启动 Harness 时通用平台与其他 ACP 后端仍正常，Python 不进入基础平台安装/检查前置。
- [ ] 内网 SDK 与配置逻辑保持既有约束；外部环境缺少私有包时记录实际限制，不替换生产 Trace 来源。

## 验证与后续流程

Python/TypeScript 双端以 mock 模型验证真实 ACP 进程、取消/恢复和人工交互，另记录真实 Agent 手工互通；真实模型和私有 SDK 证据分别留存。

本 Task 确认后先写同名 Spec；Spec 确认后写 Plan/Todo，并按可演示停点实施。继续遵守用户跳过 Skill 调用的要求，不因生成任务而直接写生产代码、认领分支或改变其他任务状态。当前只有任务文档，未运行上述产品验收。
