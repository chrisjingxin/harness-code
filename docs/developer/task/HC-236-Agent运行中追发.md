---
id: HC-236
title: Agent运行中追发
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待验收
owner: Codex
branch: harness_lody
scope: 本机会话同时提供排队与立即发送。立即发送把选中的消息交给正在运行的 Agent，供当前轮调整方向。
acceptance: 支持追发的本机 Agent 能在同一轮收到输入，现有排队行为继续可用。待发项收到追发受理后才移出队列。失败时保留原消息。
user_docs: docs/user/独立桌面工作台.md
developer_docs: 同名 Spec、Plan、Todo 和 docs/developer/architecture/Agent接入架构.md
test_evidence: 51 项 Python 与 71 项 TypeScript 定向测试、工作台 ACP 注册表至 Harness 子进程冒烟、构建、类型、依赖边界和项目检查通过。
references: HC-235；T3 Code d7373c44 的 Kiro 和 Codex 追发适配
completed_at: -
---

# HC-236 Agent运行中追发

用户可以把下一条指令留给下一轮，也可以在当前轮进行时马上补充要求。「加入队列」和「立即发送」应在界面里分开。支持追发时，输入区和每条待发项可提供「立即发送」图标。

- **排队**沿用 HC-235。当前轮正常结束后再按顺序发送。
- **立即发送**绑定发起时的会话和当前轮。Agent 确认受理后才清草稿或移除该条待发项。当前轮结束、绑定变化、Agent 拒绝或确认超时都要保留原消息，避免自动重发。
- 只为已验证支持在同一轮接收补充消息的 Agent 开放立即发送。通用 ACP 会话继续提供排队。

T3 Code 使用 Kiro 已有的 ACP 追发扩展，并用 Codex App Server 的 `turn/steer` 完成同样的操作。Harness 当前的 ACP 主入口在忙碌时返回 `THREAD_BUSY`，首批若包含 Harness，需要明确 Python 内核与 ACP 适配的分工。用户确认首批由 Harness Code 支持。外部 Agent 有已识别的追发能力时可使用。

## 实施与验证

- Harness 普通 Build 轮通过 ACP 扩展接收追发，在下一次模型调用时获知补充要求。若模型已经结束当前一步，Harness 在原 Run 继续处理已接收的消息。
- 桌面按已协商的能力显示箭头。等待确认时保留待发项。某条消息追发成功后，其余消息保持原顺序。
- 官方 ACP SDK 使用真实 Harness 执行图和离线模型验证同轮接收、取消以及历史回放。工作台 ACP 注册表至 Harness 子进程的冒烟同样通过。外部扩展使用 stdio 测试进程验证入轮通知与确认关联。Kiro 3.x 的已登录真机轮次待验收。

[HC-235](HC-235-本机会话消息排队.md) · [T3 Code Kiro 实现](https://github.com/pingdotgg/t3code/blob/d7373c44feaa85f561c0f1e829ea1c31918acbeb/packages/provider-kiro/src/server/adapter.ts#L135) · [ACP v2 提案](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#prompts-during-active-work)
