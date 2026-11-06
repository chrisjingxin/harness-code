---
id: HC-194
title: Electron 桌面端
feature_area: Web UI 与 Agent 通信协议（ACP）
priority: P1
status: 待认领
owner: 未认领
branch: -
scope: Electron 主进程直接以子进程启动 `harness acp`，经进程内通道转发给渲染层界面（替代 `harness web` 的 WebSocket 桥），复用 ACP 界面层与 AcpAgentGateway；并关闭缺口表中主进程可直接补本机能力的五项：GAP-11（文件树/预览，主进程读文件）、GAP-12（Git 面板，主进程调 git）、GAP-20（常驻子进程，刷新不取消任务）、GAP-24（@ 提及内联文件内容）、GAP-25（输入历史落盘）。
acceptance: Electron 界面可完成「发消息 → 流式 → 审批 → 取消/重发 → 历史回放」链路且无需 `harness web` 桥；缺口表中 GAP-11/12/20/24/25 状态变为「已关闭」并附测试证据（或用户确认放弃带日期）；`harness web` 浏览器入口不回退。
user_docs: docs/user/Web界面.md
developer_docs: docs/developer/architecture/ACP通信.md
test_evidence: -
references: docs/developer/task/HC-192-WebUI接入ACP协议.md、docs/developer/task/HC-193-补齐ACP缺口扩展.md、docs/developer/architecture/ACP通信.md
completed_at: -
---

## 背景

浏览器受限于沙箱，读不了本机文件、调不了 git、也保不住子进程——缺口表里 GAP-11/12/20/24/25 的「建议关闭方式」都指向 Electron 主进程。Electron 形态下不再需要 `harness web` 的 WebSocket 桥与双段凭据：主进程直接 spawn `harness acp`（stdio），进程内通道把帧转给渲染层已有的 ACP 界面层，连接安全由桌面单实例语义兜底。审批/会话/扩展协商沿用同一套 ACP 实现，不另起协议。

**立项流程要求**：立项后必须先用 `grill-me` 与用户确认范围与优先级再写 Spec。打包、签名、自动更新与分发渠道不在本 Task 的已确认范围内，需在立项时另行确认。

## 范围

- Electron 壳（主进程 + 预加载 + 渲染层）：主进程 spawn `harness acp`，渲染层复用 `acp-web/client` 的 boot-less 会话装配与 WebApp。
- 主进程本机能力注入：文件树/文件预览（GAP-11）、Git 面板（GAP-12）、@ 提及内联（GAP-24）、输入历史落盘（GAP-25）。
- 常驻子进程：界面刷新/重载不再取消运行中任务（GAP-20）。
- 打开与刷新性能（HC-192 用户验收时提出，约定在本任务处理）：见下节「性能基线」。

## 性能基线（2026-11-06，HC-192 S4 实测）

`harness web` 每次打开或刷新页面约 2.9 秒才能输入，原因是每个页面连接都冷启动一个新的 `harness acp`。用户真实配置（2 个远程 HTTP MCP）、无头 Chromium 实测拆解：

| 阶段 | 耗时 | 说明与可选优化 |
|---|---|---|
| 页面与脚本加载 | ≈0.05s | 无需处理 |
| 刷新时等旧进程退出 | ≈0.45s（首次打开无） | HC-192 已把旧进程退出从 4.5s 降到 0.37s；剩余是浏览器 409 重试间隔 450ms，可缩短到 150ms 左右 |
| Python 启动与导入（langchain 等，仅导入约 0.9s）+ initialize | ≈1.3–1.5s | 常驻或预热子进程即可消除；也可做惰性导入 |
| `session/list` | ≈0.6s | 原因未查，需先定位（疑似 SQLite 打开或列表查询） |
| 等待 `available_commands_update` | 固定 0.5s | 没有插件命令时 Python 不发命令清单，浏览器每次等满 `settleCommandsMs`；让 Python 始终发一次（可为空）即可 |

目标：Electron 形态下界面重载到可输入 ≤0.5s（主进程常驻子进程后，主要剩下界面渲染与 `session/list`）。

## 验收

- 以缺口表为准：GAP-11/12/20/24/25 各行「已关闭」附测试证据（E2E 或集成级），或用户确认放弃带日期。
- Electron 与 `harness web` 共用同一 AcpAgentGateway/界面层，协议行为一致（可用同一套脚本化 Agent 用例证明）。
