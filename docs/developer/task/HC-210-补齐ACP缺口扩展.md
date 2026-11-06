---
id: HC-210
title: 补齐 ACP 缺口扩展
feature_area: Web UI 与 Agent 通信协议（ACP）
priority: P1
status: 待认领
owner: 未认领
branch: -
scope: 关闭 docs/developer/architecture/ACP通信.md 缺口表中后续 Task 为 HC-210 的全部 GAP（GAP-01~10、13~19、21~23、26~39，共 34 项）：优先走 ACP 标准会话配置与既有字段，标准没有的能力以 _meta.harnessCode 载荷与 _harnessCode/ 自定义方法扩展实现。
acceptance: 缺口表中归属本任务的每一行要么「已关闭」（附实现与测试证据写回缺口表），要么「用户确认放弃」（带确认日期写回表）；全部关闭后缺口表无「未开始/进行中」行——本任务是 TUI 下线 Task 的前置闸门。自动化覆盖：每个被关闭的缺口有对应协议/E2E 回归用例。
user_docs: docs/user/Web界面.md、docs/user/快速开始.md
developer_docs: docs/developer/architecture/ACP通信.md、docs/developer/spec/HC-209-WebUI接入ACP协议.md
test_evidence: -
references: docs/developer/task/HC-209-WebUI接入ACP协议.md、docs/developer/architecture/ACP通信.md
completed_at: -
---

> harness_lody 分支说明：本任务与本分支的 HC-197「通用 ACP 运行时」、HC-200「Harness 独立 ACP 接入」、HC-201「Harness 轨迹与设置扩展」范围有重叠，认领前需与 HC-192 系列统筹对齐，避免重复实现。

## 背景

HC-209 一期只实现标准 ACP 加少量 `_harnessCode` 扩展（审批 presentation、runSummary、桥进程退出通知），把标准协议覆盖不到的能力逐条编号进了 ACP通信.md 的权威缺口表。这些缺口里多数是协议面缺失（ACP 标准无对应方法/字段），需要以扩展补齐，而不是界面文案糊弄。

**立项流程要求**：立项后必须先用 `grill-me` 与用户确认本 Task 的范围与优先级（34 个缺口不必一次全做，可以按组分批），再写 Spec。

## 范围分组（按建议关闭方式归类）

1. **标准会话配置与既有字段优先**：GAP-06（审批预计算携带前后文）、GAP-07（`usage_update` + 压缩方法）、GAP-08（模型会话配置项）、GAP-21/GAP-27（`session/new` 的 `mcpServers`/`additionalDirectories` 并入会话配置并补诊断事件）。
2. **`_harnessCode/` 自定义方法与通知（交互与管理面）**：GAP-01（提问）、GAP-02（计划确认）、GAP-03（goal）、GAP-04（Compose）、GAP-05（拒绝附反馈）、GAP-09（撤销/重做）、GAP-10（/btw）、GAP-13（技能管理）、GAP-14（插件与设置）、GAP-15（MCP 增删）、GAP-16+GAP-34（子代理过程与审批挂载）、GAP-17（代码索引）、GAP-18（配置查看与修改）、GAP-19（Trace，或读本地日志）、GAP-28（普通 Skill 斜杠入口）、GAP-33（`session/list` 分页）、GAP-37（命令更新带 id/来源 + 动态命令表）、GAP-39（`_harnessCode/sessions/set_title`）。
3. **`_meta.harnessCode` 载荷补齐**：GAP-30（区分 approve_thread/project）、GAP-36（SessionInfo 携带摘要四字段）、GAP-38（approval 携带 v3 原始 requests）。
4. **Python/Host 侧记录与事件补齐**：GAP-22/GAP-32（Transcript 记工具状态、回放分块分页）、GAP-23（稳定内部调用 id 贯穿事件与审批）、GAP-26（位置解析复用完整根注册表）、GAP-31（Host 模式变化广播 → `current_mode_update`）、GAP-35（事件顺序保证或翻译器重排）。
5. **桥侧断开检测**：GAP-29（桥检测断线回 `cancelled`，或审批可配置超时）。
6. **已知缺陷（HC-209 S4 测量时发现，非缺口表项）**：客户端在 `initialize` 响应返回前就发出 `session/new`（流水线发送）时，`harness acp` 对 `session/new` 不回任何响应，客户端会一直等。符合规范的客户端（含本仓库浏览器端、Zed）都先等 `initialize` 返回，所以当前不影响使用；修复目标是该请求要么排队到握手完成后处理，要么立即回 `NOT_INITIALIZED` 错误，不能静默丢弃。复现：启动 `python -m harness_agent acp`，连续写入 `initialize` 与 `session/new` 两帧不等待，只会收到 id=1 的响应。

## 验收

- 以缺口表为准：每行「已关闭」必须附实现与测试证据；「用户确认放弃」必须带确认日期。
- 本任务全部完成后缺口表无「未开始/进行中」行，**这是 TUI 下线 Task 的前置闸门**（在 TUI 下线 Task 的验收项里照抄）。
- 扩展方法与载荷必须只发给 `initialize` 声明了 `_meta.harnessCode` 扩展的客户端，与既有协商语义一致。
