# HC-234 桌面通用能力上移与ACP收口

> 2026-11-19 设计修订。用户确认由 Codex 接手，本版作为 Plan 和 Todo 的依据。

[需求卡](../task/HC-234-桌面通用能力上移与ACP收口.md) · [实施计划](../plan/HC-234-桌面通用能力上移与ACP收口.md) · [执行清单](../todo/HC-234-桌面通用能力上移与ACP收口.md) · [Agent接入架构](../architecture/Agent接入架构.md) · [ACP通信](../architecture/ACP通信.md)

---

## 1. 现状痛点、解决思路与收益

当前独立桌面工作台虽然已经完成了五层目录收敛（HC-231）与通用 ACP 运行时接入（HC-197 / HC-226），但在“功能归属”与“多 Agent 兼容性”上仍有三处错位，参考 T3 Code 的平台/Provider 分层实践，本规格对这三处边界作统一收口：

| 模块 | 现状痛点 | 解决思路（第一性原理） | 改后收益 |
| --- | --- | --- | --- |
| **1. 会话重命名** | 没有桌面改名按钮；改名靠在输入框发 `/title` 让 Harness 拦截再推送 `session_info_update`，仅改窗口内存且换别的 Agent 即失效 | **改名主权归工作台**：桌面端提供直接重命名入口并存入本机个人记录；Agent 推来的标题仅作“未手动命名时的自动起名建议” | 任意 ACP Agent（Harness/Pi/Qwen/自定义）都可随时改名，重启不丢，且不被 Agent 覆盖 |
| **2. 代码级回退** | 文件回退依赖 Harness `/undo` 命令；前端 `undo-choice.ts` 硬编码匹配中文回复文本渲染卡片 | **代码快照归平台 Git**：桌面主进程在每轮前后用隔离的 Git 引用拍快照，提供 Turn Diff 预览与仅回退代码文件；对话记忆裁剪仍归 Agent | 任意 ACP Agent 修改文件后均可查看受管目录的单轮变更，符合隔离条件的工作树可仅还原代码 |
| **3. ACP 垫片与扩展槽** | `acp-runtime` 建会未传 `additionalDirectories`/`mcpServers`，缺 v1/v2 模式归一与可选的回放静默处理；同时 `harness-acp` 写好的 `_meta` 解析器未接入桌面 | **通用底座补垫片 + 扩展槽按需挂载**：`acp-runtime` 保持零 Harness 硬编码，补全传参与多 Agent 容错；桌面通过通用扩展槽挂载 `harness-acp` 的增强解析 | 第三方 Agent 更抗造不卡死；Harness 额外获得子代理归属、审批范围、旁路标记等增强显示，拔掉扩展也能降级跑通 |

---

## 2. 边界与不变量（强制约束）

1. **五层依赖边界不变**：`packages/acp-runtime` 严禁静态或动态导入 `electron`、`@workbench/harness-acp`、`@workbench/collaboration-client` 或任何具体 Agent；`desktop/src/{ui,renderer,shared}` 严禁引入 Node 内置模块或 Electron。
2. **不越界修改远端/服务端契约**：遵循 HC-192 分工，**不修改 `server/` Java 代码、不修改 `contracts/` 线上 OpenAPI/JSON Schema、不新增非标准 ACP JSON-RPC 方法**。
3. **跨机器只读不变**：他人的共享会话继续只读；本文新增的本地重命名缓存、Git Checkpoint 均仅作用于**当前登录账号在本机运行的本人会话**。
4. **扩展可降级底线**：`_meta.harnessCode` 只承载增强信息；客户端不声明扩展或接入纯标准第三方 ACP Agent 时，对话、工具卡、审批、表单、重命名与代码快照 100% 正常工作。

---

## 3. 模块一：Thread 重命名主权上移（`desktop/`）

### 3.1 标题优先级与数据结构

在 [ConversationPersonal](../../../desktop/src/shared/personal.ts) 及主进程校验中增加可选字段 `customTitle?: string`。旧记录缺省时按未手动命名处理。本人本机会话的展示顺序为：

1. 已保存的非空 `customTitle`。
2. 当前会话有效绑定的 Agent 标题建议。
3. 协作服务端登记标题。
4. “未命名会话”。

共享会话显示服务端登记标题。左栏、顶栏和搜索读取同一归并结果。打开项目后按需加载摘要对应的本机标题，即使重启后尚未打开某个会话，也能看到属于本人的已保存标题。

### 3.2 重命名交互

输入 → 用户从本人本机会话的左栏菜单进入编辑，按 Enter 或点保存确认，按 Esc 取消。

校验 → 主进程以当前登录身份核对会话归属，校验标题写入，包括可能携带标题变化的通用个人设置保存。标题折叠连续换行和控制字符、去首尾空白，允许 1～80 个字符。无效输入保留原标题并提示。再次保存相同的手动标题可以直接结束。显式确认与 Agent 建议相同的标题仍建立手动标题。

保存 → 沿用个人记录的并发合并与持久化路径，保存成功后刷新所有展示位置。保存失败保留已确认的标题并提示重试。更换 Agent、收到标题推送或正在进行的对话都可以独立继续。

### 3.3 服务端同步缺口登记（供服务端同事后续对齐）

* **现状缺口**：当前 `@workbench/collaboration-client` 与 `server/` 仅提供 `registerConversation({ title, requestId })`（新建时写一次标题），尚无更新既有会话标题的 PATCH/POST 接口（如 `PATCH /workspaces/{ws}/projects/{proj}/conversations/{id}`）。
* **本卡处理**：按照 HC-192 不擅自新增后端 API 的约定，本卡**先完成桌面端重命名交互与 `PersonalStore` 本机持久化**，并在交接记录中明确登记该服务端接口缺口；跨设备标题同步由后续服务端任务定义。

---

## 4. 模块二：平台级 Git Checkpoint 与代码回退（`desktop/`）

> **概念说明**：
> - **`GIT_INDEX_FILE`**：Git 允许通过该环境变量指定一个临时索引文件来计算树快照，**完全不会触碰用户工作区正在使用的 `.git/index` 暂存区**。
> - **隔离引用（`refs/workbench/checkpoints/...`）**：使用普通分支之外的 Git 引用命名空间，快照对象留在本机仓库。

### 4.1 快照范围与存储结构

1. **受管目录前提**：沿用 [git-state.ts](../../../desktop/src/main/project-service/git-state.ts) 的 `detectGitRoot` 规则——仅当用户确认的工作目录恰好是 Git 仓库顶层根目录时启用快照；**普通非 Git 目录或仓库子目录平静跳过**，界面明确显示“仅在 Git 工作树根目录记录代码快照”，不报错也不影响对话。
2. **引用命名空间**：
   `refs/workbench/checkpoints/<scopeHash>/<turnOrdinal>-<phase>`
   其中 `scopeHash` 为 `[origin, accountId, workspaceId, projectId, conversationId]` 的 SHA-256 前 32 位十六进制串；`phase` 为 `base`（轮前基线）或 `post`（轮后终态）。
3. **本机轮次索引元数据**：在主进程应用数据目录（`userData/local-checkpoints/<scopeHash>.json`）按轮次顺序记录轻量索引：

```ts
export type LocalCheckpointTurnRecord = {
  readonly turnId: string
  readonly ordinal: number
  readonly createdAtMs: number
  readonly status: "completed" | "cancelled" | "failed"
  readonly gitRoot: string
  readonly directoryIdentity: { readonly dev: string; readonly ino: string }
  readonly baseRef: string | null
  readonly postRef: string | null
  readonly changedFilesCount?: number
  readonly skippedReason?: "non-git" | "timeout" | "repo-too-large" | "capture-failed"
}
```

### 4.2 快照捕获、Diff 查看与代码回退流程

#### A. 每轮自动捕获（不阻塞正常对话）

```text
输入：用户在本人会话提交一轮消息；主进程校验会话与目录后，在分发 Agent prompt 前捕获基线。
  ↓
判断：检查绑定目录是否为受信任 Git 仓库根；非 Git 仓库直接记录 skippedReason = "non-git" 并放行。
  ↓
执行（基线捕获，设 5 秒超时预算）：
  1. 在临时目录分配尚未存在的索引路径，通过 GIT_INDEX_FILE 隔离索引。
  2. 从 HEAD、真实索引与遵守 Git 忽略规则的未跟踪清单合并候选路径，空仓库从空树开始。
  3. 核对目录及文件身份，读取工作树原始字节，通过临时索引构造树。快照最多 1,000 个路径和 32 MiB 内容。
     Git 过滤器不参与捕获，子模块、嵌套仓库或特殊文件令本轮快照降级。
  4. git write-tree → git commit-tree → git update-ref 保存为 baseRef；清理临时索引。
  5. 若捕获超时或失败，记 skippedReason 并照常放行 Agent 执行（不能因为快照慢卡死对话）。
  ↓
终态捕获（轮次收到 completed / cancelled / failed 时）：
  等待 Agent 此轮执行结束且可以确认停止写入，再捕获 postRef（取消和失败同样适用）。
  下一轮 prompt 和代码回退应等待同一目录的终态快照完成或超时。无法界定轮次边界时标记该轮 Diff 不可用。
  主进程串行登记同一物理目录的这些操作。快照对比的是两次捕获间的工作树，期间的外部改动也可能显示在 Diff 中。
```

#### B. 查看单轮代码变更（Turn Diff）

* [桌面本机执行契约](../../../desktop/src/shared/local-execution-host.ts) 提供按 `turnId` 查询变更清单和单文件 Diff 的动作。
  - 从本机索引解析两端引用，用 Git 的 NUL 分隔输出读取变更路径与统计，覆盖重命名、二进制及含空白的路径；
  - `git diff --unified=3 <baseRef> <postRef> -- <path>` 获取单文件差异文本（复用既有 Diff 面板与 `DIFF_LIMIT` 96 KiB 截断保护）。

#### C. 回退代码文件

1. **预览与确认**。普通 Git 根目录可以捕获并查看轮次 Diff。整树回退仅开放给本会话专用、用户确认的已登记 Git linked worktree。主进程校验当前账号和项目会话、目录实体、目标引用及快照完整性，并检查其他会话已登记的目录，覆盖空闲会话以及同目录或父子目录重叠。主工作树、共享目录或无法确认隔离时，界面解释原因并保留 Diff。
2. **写入前核对**。在同一目录的串行操作中确认空闲并复核预览后的工作树，准备完整的改写和删除路径列表。必须先保存可从桌面定位的保护快照。若目标路径或祖先与未纳入保护快照的忽略文件、符号链接、嵌套仓库或其他无法安全往返的内容冲突，整次拒绝，保留原文件。保护快照创建、路径核对或目录授权校验失败时同样拒绝。
3. **还原与恢复**。根据路径清单更新工作树，使用隔离索引且保留用户暂存区、HEAD 和分支。主进程报告成功后刷新文件树和 Diff。发生部分写入时，记录并报告受影响路径，保留保护快照并提供可定位的恢复入口。确认后发生的已检测到的外部改动须先重新预览，恢复失败与部分应用都应有明确状态。

### 4.3 清理中文撤销卡片

删除 `undo-choice.ts` 对中文回复的匹配和消费。Harness 支持独立的 `conversation` 回退模式，提示对话撤销时明确使用该模式。桌面代码回退只处理本机文件。

---

## 5. 模块三：通用 ACP 兼容垫片与 Harness 增强接线

### 5.1 `@workbench/acp-runtime` 通用能力补齐与兼容垫片

以下改动全部保持在 `packages/acp-runtime` 内，**严禁出现任何 Harness / Pi / Qwen 名称或私有字段判断**：

1. **会话建会/恢复标准参数补全（[session.ts](../../../packages/acp-runtime/src/session.ts)、[types.ts](../../../packages/acp-runtime/src/types.ts)）**：
   - 经可信宿主的绑定选项接收可选的 `additionalDirectories` 与 `mcpServers`，复用固定版本 SDK 的请求类型。目录使用本机明确授权的绝对路径，发送前重新核对真实路径及目录身份。MCP 来自显式的可信宿主配置，校验传输、命令、参数及 URL 形状，沿用系统 TLS 校验。空配置走现有默认路径。
   - 为 `newSession` / `loadSession` / `resumeSession` 共用一次能力过滤。附加目录要求 `sessionCapabilities.additionalDirectories`，额外 MCP 传输按 SDK 的 `mcpCapabilities` 协商。过滤项提供受限诊断。Git 快照范围仍是选定的主工作树。
2. **ACP v1 / v2 模式字段兼容垫片（[session-state.ts](../../../packages/acp-runtime/src/session-state.ts)）**：
   - 部分 ACP v1 Agent 在 `NewSessionResponse` / `LoadSessionResponse` 顶层返回 `modes`（`SessionModeState`），而遵循 ACP 新版规范的 Agent 则把模式放在 `configOptions` 中且 `category === "mode"`（不再填顶层 `modes`）。
   - 在 `parseModes` + `parseConfigOptions` 归并阶段增加兼容逻辑：
     - 有有效 `mode` 类 `select` 配置时优先使用该项，否则使用顶层 `modes`。建会/恢复响应、配置写入响应与 `config_option_update` 共用同一归并规则，UI 只显示一个模式选择器。
     - 调用 `setMode(modeId)` 时，若底层模式来自 `configOptions[category="mode"]`，自动路由到 `session/set_config_option`，否则走 `session/set_mode`。
3. **`loadSession` 回放卡死兜底（[session.ts](../../../packages/acp-runtime/src/session.ts)）**：
   - 保留现有默认 15 秒握手硬超时。可信宿主可启用 `sessionLoadReplayIdleMs`，从当前恢复请求收到第一条有效回放帧开始计时，后续同会话有效回放帧刷新静默计时。硬超时同时生效。缺少成功 RPC 响应时按恢复失败处理，结束旧连接并隔离迟到帧。`strict` 报告失败并保留原生绑定，`fallback-new` 使用干净连接新建。
4. **跨重建上下文衔接钩子（`session-reset` continuity）**：
   - 当原生会话因 Agent 不支持 `loadSession` 或进程过期触发 `session-reset`（回退到 `newSession`）时，`BoundSession` 通过 `session-reset` 事件通知宿主；
   - 在桌面协调层（`local-execution-coordinator.ts`），若用户本轮是在旧会话上继续提问（存在历史定稿消息）且发生 `session-reset`，桌面从同账号、同项目、同会话的本机定稿缓存选取最近的消息文本，按 UTF-8 计最多 8 KiB，标为历史引用附在首次发给新原生会话的 prompt 中。成功恢复或首次建会无此附加内容。同一新原生会话最多发送一次，覆盖绑定时发生重置和发送时发生重置两条路径，用户界面和定稿上传保留原文。
5. **一致性套件补强（[conformance.ts](../../../packages/acp-runtime/src/conformance.ts)）**：
   - 新增标准检查项：v2 `configOptions[category="mode"]` 模式切换校验、`loadSession` 超时/回退校验、`additionalDirectories` / `mcpServers` 能力协商校验。

### 5.2 通用扩展槽与 `@workbench/harness-acp` 接入

为守住 `packages/acp-runtime` **零特定 Agent 硬编码**的不变量，扩展接入采用“通用插槽（Extension Slot）”模式：

```text
@workbench/acp-runtime（通用运行时，只定义通用插槽接口，不认识 Harness）
  ├─ 握手插槽：LocalAcpHostOptions.extraClientCapabilitiesMeta?: Record<string, unknown>
  ├─ 保留工具、审批、文本帧、会话信息、命令和 prompt 终态的可选附加元数据
  └─ 不包含任何 "harnessCode" 字符串或解析代码

@workbench/harness-acp（可选适配器，只依赖 @workbench/acp-runtime）
  ├─ 导出 HARNESS_CLIENT_EXTENSION_CAPABILITIES
  └─ 提供专有元数据解析器

desktop/src/main/local-acp-host.ts & local-execution-coordinator.ts（桌面装配层）
  └─ 仅当当前选中的 descriptor.id === "harness"（或显式注册了扩展适配器）时注入插槽并调用适配器投影函数；
     客户端及 Agent 都协商了对应能力才使用解析器。渲染层收取校验后的父工具标识、审批范围、旁路标记和轮次统计。
```

通过该通用扩展槽在桌面前端落地以下 4 项增强消费（全部为可选增强展示，缺失时无缝回退）：

1. **子代理父子挂载（`subagent`）**：调用 `parseHarnessParentMeta` 解析 `parent.toolCallId`，在时间线展示中将子代理工具卡归组或缩进挂载至对应的父级 `task` 工具卡下方（不再平铺打断主流程）。
2. **审批作用域展示（`approval`）**：调用 `parseHarnessApprovalMeta` 读取 `scope`（`once` / `thread` / `project`），在审批卡片选项旁给出更清晰的作用域说明（如“仅本次”、“本会话内允许”、“本项目目录允许”）。
3. **旁路提问临时标记（`commands`）**：调用 `parseHarnessCommandMeta` 读取 `ephemeral: true`（如 `/btw` 旁路问答），在本地渲染旁路内容，主进程在定稿入队前用文本帧或终态上的受信标记排除旁路输入和输出。`historyChanged` 表示原生历史已变，使用现有定稿同步规则，协作历史修订由后续契约另行定义。
4. **单轮耗时与缓存用量（`runSummary`）**：调用 `parseHarnessRunMeta` 读取 `durationMs` 与 `cachedTokens`，在完成态工具/消息页脚按需展示轻量耗时与缓存命中提示。

---

## 6. 停点划分与交付验证口径

| 停点 | 交付范围 | 可观察验收结果 |
| --- | --- | --- |
| **停点 1** | 桌面会话改名 | 左栏菜单可直接重命名本人会话，左栏、顶栏和搜索显示一致，重启后保留。Agent 建议仅在没有手动标题时生效 |
| **停点 2** | 模块二：平台级 Git Checkpoint 与代码回退（`desktop/`） | Git 工作区每轮自动记 `baseRef`/`postRef`；可查看单轮文件差异，隔离工作树可仅还原代码文件，暂存区与分支保持原状态。共享目录仅展示 Diff，非 Git 目录可继续对话 |
| **停点 3** | 模块三：ACP 兼容垫片 + Harness 扩展槽接线 | `acp-runtime` 补全建会参数、v1/v2 模式归一、回放兜底与重置摘要衔接并通过一致性测试；Harness 展示子代理挂载/审批范围/旁路标记，不开启扩展时照常跑通 |

实施阶段按 Plan 执行受影响的构建、类型、边界、最小回归和窗口冒烟。全卡收口时核对以下证据。
- `npm run check:boundaries -- --self-check`（验证 4-workspace 边界、`acp-runtime` 零 Agent 硬编码、`desktop/src/{ui,renderer,shared}` 隔离）；
- `npm run build` 与 `npm run typecheck`；
- 受影响单测（`packages/acp-runtime/tests/*.test.ts`、`packages/harness-acp/tests/*.test.ts`、`desktop` 对应测试）；
- `npm run project:check` 与真实 Electron 窗口主路径冒烟（由 HC-204 统一做全平台与服务端联调回归）。
