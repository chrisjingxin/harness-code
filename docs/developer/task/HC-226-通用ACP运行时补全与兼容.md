---
id: HC-226
title: 通用ACP运行时补全与兼容
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P0
status: 待验收
owner: Codex
branch: feat_hc_226_通用ACP运行时补全与兼容
scope: 在 @workbench/acp-runtime 中补全标准 ACP 会话状态与全量 SessionUpdate 消费、原生会话绑定清理与恢复回退策略、工作区沙箱 fs/* 与可选 terminal/* 反向 RPC 及终端内容映射、可选 elicitation 表单交互以及可复用的标准 ACP 一致性测试套件，同时严格保持既有 LocalAcpEvent 七类轮次事件与连续序号对桌面主进程的兼容。
acceptance: session.subscribe 严格保持 7 类轮次事件及 1..N 连续序号与 local-execution-ipc.ts 兼容；getState/subscribeSession 完整承载初始化信息、模式/模型/配置/命令表/计划/用量、loadSession 回放及可选 elicitation；nativeBinding.clear 与 restorePolicy=fallback-new 在 loadSession 不支持或失败时自动重置绑定；fs/* 与 terminal/* 严格限制在工作区 root 内并清理子进程；runAcpConformanceSuite 在 mock Agent 上通过且能检出缺陷。
user_docs: 不涉及（本卡仅补全底层 @workbench/acp-runtime 协议能力层，桌面端消费入口待后续装配）
developer_docs: docs/developer/architecture/Agent接入架构.md；docs/developer/task/HC-197-通用ACP运行时.md
test_evidence: 2026-11-18：`npm run build --workspace @workbench/contracts --workspace @workbench/acp-runtime --workspace @workbench/runner-core --workspace @workbench/project-service --workspace @workbench/ui --workspace @workbench/runner` 通过（注：全库 `npm run build` 在 `@workbench/desktop` 的 `electron-vite build` 因基线 `harness_lody` 的 `package-lock.json` 在 `darwin arm64` 缺少可选依赖 `@rolldown/binding-darwin-arm64` 失败）；`npm run typecheck` 7 个 workspace 全通过，且 strict `tsc --noEmit` 校验 5 个测试文件通过；`npm run check:boundaries -- --self-check` 通过；`node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs --test packages/acp-runtime/tests/*.test.ts` 22/22 通过；`bun test packages/acp-runtime/tests/*.test.ts` 22/22 通过；`bun test apps/desktop/tests/` 32/32 通过；`npm run test:project` 18/18 通过；`npm run tasks:sync` 与 `npm run tasks:check` 通过。
references: docs/developer/architecture/Agent接入架构.md；docs/developer/task/HC-197-通用ACP运行时.md
completed_at: -
---

# HC-226 通用ACP运行时补全与兼容

## 现状痛点与解决思路

此前 `@workbench/acp-runtime` 仅支持最小文本流式与权限审批：握手发送空 `clientCapabilities: {}`、忽略 `SessionUpdate` 中除正文/思考/工具外的 9 类通知、`loadSession` 回放期间因未设 `sessionId` 且 `!prompting` 而全量丢弃历史、`nativeBinding` 无清理且不支持 `loadSession` 时直接永久锁死会话，且缺失 `fs/*`、`terminal/*` 反向 RPC 与标准 ACP 一致性测试套件。

本次在保持 `LocalAcpEvent` 与 `session.subscribe(...)` 对 [`local-execution-ipc.ts`](../../../apps/desktop/src/main/local-execution-ipc.ts) 完全向后兼容的前提下，以增量接口补齐通用 ACP 客户端能力层。

## 主要交付内容

1. **会话完整状态、控制方法与富更新通道（[`index.ts`](../../../packages/acp-runtime/src/index.ts)、[`session.ts`](../../../packages/acp-runtime/src/session.ts)、[`session-state.ts`](../../../packages/acp-runtime/src/session-state.ts)）**
   - 新增 `getState(): LocalAcpSessionState` 与 `subscribeSession(...)`，解析并持续更新 `agentInfo`、`agentCapabilities`、`authMethods`、`modes`/`currentModeId`、`models`、`configOptions`、`availableCommands`、`plans`、`sessionInfo`、`usage` 与 `restoreStatus`。
   - 处理全部 13 类 `SessionUpdate`：会话级通知在空闲期与运行期均更新状态并推送至 `subscribeSession`；`loadSession` 回放窗口内的历史帧收集为 `{ type: "replay", frame }` 推入 `subscribeSession`，绝不泄漏到 `subscribe()` 轮次流。
   - 新增 `connect()`、`setMode()`、`setConfigOption()`、`authenticate()`、`listSessions()`、`resumeSession()`、`sendPrompt(blocks)`（支持 `text`、`resource`、`resource_link`、`image`，`send(text)` 复用之），以及 opt-in 的 `enableElicitation`（默认 `false`）+ `answerElicitation()`（在 `cancel()`/`close()` 时自动取消挂起表单）。
2. **修复 `nativeBinding` 重开死锁（[`native-binding.ts`](../../../packages/acp-runtime/src/native-binding.ts)、[`session.ts`](../../../packages/acp-runtime/src/session.ts)）**
   - 为 `NativeBinding` 增加 `clear()` 并将 `write()` 改为临时独占文件 + `rename` 原子覆盖。
   - 增加 `restorePolicy?: "fallback-new" | "strict"`（默认 `"fallback-new"`）：当 `loadSession` 不被支持或恢复失败时，自动清除失效绑定、回退 `newSession` 写入新 ID，并设置 `restoreStatus = { kind: "reset", reason, ... }` 及发射 `{ type: "session-reset" }`；`"strict"` 模式保留 `RestoreError` 语义。
3. **工作区沙箱反向 RPC 与工具终端引用（[`client-capabilities.ts`](../../../packages/acp-runtime/src/client-capabilities.ts)、[`tool-update.ts`](../../../packages/acp-runtime/src/tool-update.ts)）**
   - `toLocalAcpTool` 提取 `item.type === "terminal"` 的 `terminalId`（过滤控制字符与空白）。
   - 默认启用沙箱化的 `fs/read_text_file` 与 `fs/write_text_file`（`enableClientFs?: boolean`，默认 `true`），通过 `realpath` 归属检查、`O_NOFOLLOW` 与字节上限严禁跨目录及软链接逃逸。
   - 提供可选 `terminal/*` 反向 RPC（`enableClientTerminal?: boolean`，默认 `false`），校验 `cwd` 归属工作区、按 UTF-8 字符边界截断前部输出，并在轮次结束及会话关闭时强制清理所有终端子进程。
4. **标准 ACP 一致性测试运行器（[`conformance.ts`](../../../packages/acp-runtime/src/conformance.ts)）**
   - 实现 `runAcpConformanceSuite(command, options?)`，覆盖握手、建会流式正文、工具生命周期、权限审批、取消与恢复发送、`loadSession`/回退重置、畸形 stdout 失败关闭及 EOF 进程退出，并在 [`conformance.test.ts`](../../../packages/acp-runtime/tests/conformance.test.ts) 对标准、无 `loadSession` 与缺陷 mock Agent 完成正反验证。

## 验证记录

- `rtk npm run build --workspace @workbench/contracts --workspace @workbench/acp-runtime --workspace @workbench/runner-core --workspace @workbench/project-service --workspace @workbench/ui --workspace @workbench/runner`：通过。
- `rtk npm run build`：前 6 个 TS 工作区通过，`@workbench/desktop` 的 `electron-vite build` 因基线 `harness_lody` 的 `package-lock.json` 在 `darwin arm64` 缺少可选依赖 `@rolldown/binding-darwin-arm64` 失败（已如实记录，未改动锁文件）。
- `rtk npm run typecheck`：全部 7 个工作区通过；额外使用 `tsc --noEmit` 严格校验 `packages/acp-runtime/tests/*.test.ts` 通过。
- `rtk npm run check:boundaries -- --self-check`：通过（7 个 workspace + 负例夹具）。
- `rtk node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs --test packages/acp-runtime/tests/*.test.ts`：22/22 通过（`tool-update.test.ts` 9 项、`session.test.ts` 1 项、`session-compat.test.ts` 6 项、`client-capabilities.test.ts` 3 项、`conformance.test.ts` 3 项）。
- `rtk bun test packages/acp-runtime/tests/*.test.ts`：22/22 通过；`rtk bun test apps/desktop/tests/`：32/32 通过；`rtk npm run test:project`：18/18 通过。
- `rtk npm run tasks:sync` 与 `rtk npm run tasks:check`：通过。
