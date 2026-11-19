---
id: HC-234
title: 桌面通用能力上移与ACP收口
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Antigravity
priority: P1
status: 待验收
owner: Codex
branch: feat_hc_234_桌面通用能力上移与ACP收口
scope: 参照 T3 Code 的平台/Provider 解耦思路，在桌面工作台与通用 ACP 运行时完成三项收敛：1）将 Thread 重命名主权上移至桌面端与个人/协作元数据层（UI 直接改名、用户标题不被 Agent session_info_update 覆盖，并明确服务端持久化接口缺口边界）；2）将本机代码级 Checkpoint 与 Turn Diff/代码回退上移至桌面 project-service 的 Git 快照层，解除前端 undo-choice 对 Harness 中文正则的硬编码依赖；3）补全 @workbench/acp-runtime 标准能力与第三方兼容垫片（建会参数、modes/configOptions 归一、loadSession 超时/无响应与无原生恢复时的历史摘要衔接），并在桌面宿主扩展槽安全接通已定义但未消费的 @workbench/harness-acp _meta.harnessCode 增强解析（保持无扩展降级可用）。
acceptance: 桌面端支持本地直接重命名本人会话且切换第三方 ACP Agent 后依然可用，Agent 推送的 session_info_update.title 仅在用户未手动命名时生效；Git 工作区下每轮执行前后自动记录隔离快照 ref，支持查看单轮文件差异，已确认隔离的 Git worktree 支持仅回退代码文件（共享目录仅展示 Diff，非 Git 目录可继续对话）；@workbench/acp-runtime 支持传入 additionalDirectories/mcpServers、统一 v1/v2 modes 与 configOptions、处理 loadSession 卡死与无原生恢复兜底；接通 _meta.harnessCode 后 Harness 可展示子代理父子挂载、审批范围与 ephemeral 旁路标记，不声明扩展时标准 ACP 全流程照常运行；通过 npm run build、npm run typecheck、npm run check:boundaries -- --self-check、受影响单测与 npm run project:check。
user_docs: 实施阶段按需更新 docs/user/独立桌面工作台.md
developer_docs: 同名 Spec、Plan、Todo，实施收口时同步 docs/developer/architecture/Agent接入架构.md
test_evidence: 四项工程检查、91 项定向测试、macOS 正式 Electron 三停点 Computer Use 端到端测试通过，见本卡交付记录
references: docs/developer/architecture/Agent接入架构.md；docs/developer/architecture/ACP通信.md；docs/developer/task/HC-197-通用ACP运行时.md；docs/developer/task/HC-199-文件与Git服务迁移.md；docs/developer/task/HC-226-通用ACP运行时补全与兼容.md；docs/developer/task/HC-229-多代理适配与会话全量接线.md；docs/developer/task/HC-231-五层架构与多语言目录重构.md
completed_at: -
---

# HC-234 桌面通用能力上移与ACP收口

## 要解决的问题（对照第一性原理与 T3 Code 实践）

对照当前仓库实现、ACP 官方协议（`@agentclientprotocol/sdk` `0.25.1`）以及 T3 Code 的分层架构，当前桌面工作台存在三处“归属错位”与“两头未接顺”的问题：

1. **会话重命名主权倒挂在 Agent 斜杠命令上**：
   - 现状：桌面端没有独立的会话重命名 UI 入口；用户在聊天框发 `/title 新名称` 依赖 Harness 内核拦截后再通过 `session_info_update` 推回窗口内存的 `titleOverridesByKey`（见 [session-model.ts](../../../desktop/src/renderer/features/session/session-model.ts) 与 [use-project-sessions.ts](../../../desktop/src/renderer/features/session/use-project-sessions.ts)），既未持久化到协作服务端，换用第三方 ACP Agent 后也直接失去改名能力。
   - 原则（参照 T3 Code `thread.metadata.update`）：Thread 身份与标题是平台一等公民元数据，归桌面端与协作服务端；Agent 推送的 `session_info_update.title` 仅作可选“自动起名建议”，用户手动命名后不得被 Agent 覆盖。

2. **代码级回退耦合了 Harness 私有文本格式**：
   - 现状：本机文件浏览与只读 Git 已收敛在 [project-service/git.ts](../../../desktop/src/main/project-service/git.ts)，但“回退代码”仍依赖 Harness 内核的 `/undo` 斜杠命令，且 `undo-choice.ts` 通过正则硬解析助手回复的中文 Markdown（`可回退的回合` / `- #N ...`）来渲染卡片按钮。换任意外部 ACP Agent 后功能失效，且文案微调即断裂。
   - 原则（参照 T3 Code `CheckpointServiceV2`）：桌面端在每轮执行前后用独立 Git ref 记录工作树。整树还原只在已确认隔离的工作树开放。对话记忆裁剪由 Agent 自身处理。

3. **通用 ACP 运行时兼容垫片不足，且 Harness 增强解析未接通**：
   - 现状一方面，[packages/acp-runtime](../../../packages/acp-runtime/src/session.ts) 在 `newSession`/`loadSession`/`resumeSession` 时仍传空 `mcpServers: []` 且未透传 `additionalDirectories`，也缺少应对第三方 ACP Agent 常见方言/异常的兼容垫片（如 ACP v1 顶层 `modes` 与 v2 `configOptions[category=mode]` 归一、保留 `session/load` 硬超时并补齐可选的回放静默处理、`loadSession` 不可用或失败时的上下文摘要衔接）。
   - 另一方面，[packages/harness-acp/src/meta.ts](../../../packages/harness-acp/src/meta.ts) 已定义全套 `_meta.harnessCode` 解析器，但 [buildClientCapabilities](../../../packages/acp-runtime/src/session-state.ts) 未做扩展声明协商，桌面端也未调用任何 `parseHarness*` 函数，导致子代理父子卡挂载、审批作用范围、`runSummary`、`/btw` 旁路标记等增强体验均未在工作台生效。

## 核心改造范围（按五层架构落包）

> **边界守则（沿用 HC-192 分工）**：本卡仅改动 `desktop/`、`packages/acp-runtime/`、`packages/harness-acp/` 与配套文档；**不新增后端 Java API、不修改 `contracts/` 线上 schema、不改动 `server/`、不新增非标准 ACP 方法**。若涉及服务端持久化缺口（如会话标题服务端改名接口），在本卡记录缺口并由桌面本地存储兜底。

### 模块一：Thread 改名主权上移（`desktop/`）

1. **桌面端显式改名入口与标题主权保护**：
   - 在左栏本人会话菜单提供直接重命名交互。左栏、顶栏和搜索使用同一显示标题。
   - 在 [PersonalStore](../../../desktop/src/main/personal-store.ts) 会话个人记录中保存用户显式设置的 `customTitle`，由主进程校验本人会话并支持重启恢复。
   - 修改 `resolveConversationTitle` 与 `session_info_update` 归并规则：用户未手动改名时，可采纳 Agent 推送的自动标题建议；一旦用户手动命名，后续 `session_info_update.title` 只记录为参考元数据，绝不覆盖用户标题。
2. **服务端同步缺口显式登记**：
   - 当前协作服务端仅提供新建登记 `registerConversation({ title })`，尚无独立的会话重命名接口。
   - 本卡不修改 `server/` 与 `contracts/`；在 Spec 中登记标题同步接口缺口，供服务端同事按需补齐（补齐前通过本地 `PersonalStore` 保障本人本机持久可用）。

### 模块二：平台级 Git Checkpoint 与代码回退（`desktop/`）

1. **本机隔离 Git 快照服务（`desktop/src/main/project-service/`）**：
   - 参考 T3 Code `CheckpointServiceV2` 思路，在 `project-service` 新增只作用于本机受信任目录的快照能力：使用独立于用户分支与工作区索引的隐藏 Git ref 命名空间（如 `refs/workbench/checkpoints/<conversationScopeHash>/...`）及临时 `GIT_INDEX_FILE`，在每轮执行受理前（baseline）与终态完成后（post-turn）记录工作区树快照。
   - 严格守卫：不污染用户 `git status`、不修改当前 `HEAD`/分支、普通非 Git 目录平稳跳过并提示“当前目录非 Git 仓库，暂不支持代码快照回退”、单次捕获设置超时上限（不阻塞正常问答）。
2. **Turn Diff 查看与代码回退 UI（`desktop/src/renderer/features/session/`）**：
   - 为本人会话轮次提供 Git Diff。在已确认隔离的工作树开放代码回退，先完成保护快照和路径冲突校验。
   - 与 Agent 对话回退解耦：解除 `undo-choice.ts` 对中文纯文本正则的强绑定；Harness 的对话撤销走独立的 `conversation` 模式。

### 模块三：通用 ACP 兼容垫片与 Harness 增强接线（`packages/acp-runtime/` + `packages/harness-acp/` + `desktop/`）

1. **`packages/acp-runtime` 通用协议补齐与第三方 Agent 兼容垫片**：
   - **建会参数补全**：在 `LocalAcpSession` / `BoundSession` 开放 `additionalDirectories` 与 `mcpServers` 传参（含安全边界校验）。
   - **模式与配置统一归一**：在 `session-state.ts` 中兼容 ACP v1 顶层 `modes` 与 v2 `configOptions` 中 `category === "mode"` 的表示形式，避免不同版本第三方 Agent 接入时模式下拉消失。
   - **恢复与取消容错**：为 `loadSession` 增加可配置的回放静默/超时兜底策略，避免部分第三方 Agent 回放结束不回包导致界面永久卡在加载态；当原生会话不可恢复（`session-reset`）时，桌面利用已有重置事件，从同会话本机定稿缓存准备有上限的首轮历史引用。
   - **一致性套件扩展（[conformance.ts](../../../packages/acp-runtime/src/conformance.ts)）**：补充上述兼容场景的自动化校验用例。
2. **`packages/harness-acp` 扩展协商与桌面扩展槽接线（[local-acp-host.ts](../../../desktop/src/main/local-acp-host.ts) / [local-execution-coordinator.ts](../../../desktop/src/main/local-execution-coordinator.ts)）**：
   - 保持 `@workbench/acp-runtime` 零 Harness 硬编码不变量，通过通用扩展槽/能力钩子让 `harnessAcpDescriptor` 在握手时声明 `HARNESS_CLIENT_EXTENSION_CAPABILITIES`。
   - 将 `meta.ts` 中的 `parseHarnessParentMeta`（子代理工具卡归属父卡）、`parseHarnessApprovalMeta`（审批作用域标注）、`parseHarnessCommandMeta`（`/btw` `ephemeral` 标记）、`parseHarnessRunMeta`（耗时与缓存统计）投影为桌面通用增强字段。
   - 强制验证：**关闭或移除 `harness-acp` 扩展声明时，全部核心对话、工具、审批、表单与平台侧改名/代码回退功能 100% 正常工作。**

## 可演示停点

1. **停点 1（桌面会话主权）**：桌面端可直接重命名本人会话，重启应用后保留，且第三方标准 ACP Agent 接入时改名正常、不被 `session_info_update` 覆盖。
2. **停点 2（平台代码 Checkpoint）**：任意 ACP Agent 跑完一轮改文件后，可查看该轮 Git 变更。在隔离的工作树可回退代码文件，共享目录仍可查看 Diff，非 Git 目录仍可发送。
3. **停点 3（ACP 兼容垫片与 Harness 增强槽）**：`acp-runtime` 通过新增兼容性测试；连接 Harness 时正常呈现子代理嵌套、审批范围与 `/btw` 旁路标记，切换纯标准 Agent 时无缝降级。

## 验收标准

- 满足五层架构依赖边界：`npm run check:boundaries -- --self-check` 通过，`packages/acp-runtime` 保持零 Harness / Electron 硬编码。
- 桌面端会话重命名、Git Diff 与隔离工作树回退在 Harness 与纯标准外部 ACP Agent（或一致性 Mock Agent）下均可用。
- `npm run build`、`npm run typecheck`、受影响包测试及 `npm run project:check` 通过。

## 认领与实施依据

2026-11-19 由 Codex 在独立 worktree 认领。实施按[规格](../spec/HC-234-桌面通用能力上移与ACP收口.md)、[计划](../plan/HC-234-桌面通用能力上移与ACP收口.md)和[清单](../todo/HC-234-桌面通用能力上移与ACP收口.md)逐停点推进。

## 停点 1 交付记录（待验收）

- 本人会话行的「…」菜单支持直接重命名，左栏、顶栏与搜索从同一展示标题读取。主进程校验本人归属并独立提交手动标题，草稿与个人视图的并发保存保留该标题。
- `npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check` 和 `npm run project:check` 通过。桌面个人存储、标题模型与本机执行视图定向测试共 35 项通过。
- macOS 已构建的正式 Electron 窗口使用隔离用户目录、符合当前契约的 loopback HTTP 夹具及标准 ACP 测试 Agent。验证了 Agent 建议、侧栏按 Enter 保存、顶栏与搜索一致、后续 Agent 建议保持手动标题、他人写入拒绝、切换项目和退出后重新登录时未打开会话的标题恢复。
- 协作服务目前只在会话登记时写标题。跨设备改名需要服务端提供独立的标题更新能力，本机改名通过个人记录持久化。

## 三个停点收口验证（待验收）

| 停点 | macOS 正式 Electron 窗口的 Computer Use 结果 |
| --- | --- |
| 1 · 改名 | 从侧栏菜单保存标题，顶栏和搜索同步显示。Agent 后续建议、Agent 切换和应用退出后重新登录均保留手动标题 |
| 2 · Git 快照 | 标准 ACP 在临时 linked worktree 修改 `code.txt`。窗口显示轮前与轮后 Diff、还原路径预览及原生确认。确认后文件内容恢复为 `before ACP`，保护快照入口可见。非 Git 目录能继续完成对话并显示快照降级原因 |
| 3 · ACP 兼容与扩展 | 标准配置型模式和旧版模式均可在同一选择器切换。测试 Harness 显示父子工具、审批作用域、耗时和缓存。标准 Agent 原生恢复失败后可继续对话 |

应用使用临时用户目录、loopback 协作服务夹具和隔离的标准 ACP / Harness 协商测试进程。对照窗口操作后的夹具记录，普通轮次成功上传，`/btw` 输入与回复均留在本机，重建轮次只把历史引用发给 Agent，协作记录保留用户原文。

`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm run project:check` 和 91 项定向测试通过。定向测试覆盖暂存区与 HEAD、共享目录、忽略文件冲突、部分写入与保护快照、模式写入、附加目录和 MCP 协商、回放静默、严格恢复、进程替换、摘要单次发送和定稿队列。真实目标服务和双平台验收沿用 HC-204。

```sh
node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs --test \
  packages/acp-runtime/tests/*.test.ts packages/harness-acp/tests/*.test.ts \
  desktop/tests/{personal-store,session-model,code-checkpoints,local-execution-ipc,local-execution-view,project-service,timeline-model,local-acp-providers}.test.ts
```
