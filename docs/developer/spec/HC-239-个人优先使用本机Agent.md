# HC-239 个人优先使用本机 Agent 行为规格

> 状态：规格草案（2026-11-23，待审阅）。本文定义 [HC-239 Task](../task/HC-239-个人优先使用本机Agent.md) 的行为契约、跨端数据模型、存储方案、授权边界与可验证验收标准，对应 [个人与团队协同用户旅程](../architecture/个人与团队协同用户旅程.md) 第 4 节及第 7 节旅程 0、1、8，并与 [HC-233 Spec](HC-233-项目记忆与团队知识读取.md) 对齐本机执行作用域。

[需求卡](../task/HC-239-个人优先使用本机Agent.md) · [用户旅程总纲](../architecture/个人与团队协同用户旅程.md) · [方案 B 交互原型](../previews/personal-team-workbench/README.md) · [HC-233 统一设计](HC-233-项目记忆与团队知识读取.md)

---

## 1. 现状痛点、解决思路与改后收益

### 1.1 现状痛点

当前桌面工作台把“使用本机 Agent”和“加入团队并进入某个 Project”强绑定在了一起：

1. **未入团或未选团队被阻断**：[桌面根装配](../../../desktop/src/renderer/desktop-workbench.tsx) 仅在 `signedIn && account === "ready" && workspace` 同时成立时才渲染工作台；未加入任何团队时，界面只显示“当前账号未加入团队”的死路，无法打开会话。
2. **本机执行每次都联网查云端 Project**：[本机执行协调器](../../../desktop/src/main/local-execution-coordinator.ts) 中的 `authorize()` 每次准备会话、发送消息、审批或恢复检查点时，都必须调用 `identity.getProjectConversation(...)` 向服务端确认该会话属于某个 Project。只要服务端不可用、断网，或者会话不在 Project 内，本机 Agent 就直接被拒绝。
3. **本机状态按团队/项目硬编码四元组**：[本地作用域契约](../../../desktop/src/shared/local-execution-host.ts)、[个人视图存储](../../../desktop/src/main/personal-store.ts)、[原生绑定标识](../../../packages/acp-runtime/src/native-binding.ts) 与 [代码检查点](../../../desktop/src/main/project-service/checkpoints.ts) 均要求非空的 `(accountId, workspaceId, projectId, conversationId)`，导致“无团队个人会话”无处落盘，且个人会话一旦发布到 Project 就会改变 `projectId` 而打断原生会话与目录绑定。
4. **缺冷启动预检、多团队切换与轻共享档位**：首次使用没有可用 ACP（Agent Client Protocol，桌面与本机 Agent 进程之间的标准 JSON-RPC 通信协议）Agent 连通性预检引导；左栏缺少多团队与个人无团队切换器；分享给队友时只有“完整对话同步”，缺少“仅共享状态与成果摘要”档位，也没有单向“停止共享”动作。

### 1.2 解决思路与改后收益

- **一套会话模型，执行权与可见性解耦**：把“谁能在本机运行 Agent”（执行权 = 当前登录账号 + 本机会话归属 + 用户授权目录）与“谁能看到这段对话”（可见性 = 是否主动发布到某个 Project）彻底拆开。云端同步只是挂在会话上的可选“发布器”，不再是本机执行的门槛。
- **团队上下文与共享范围分离**：会话新建时记录选中的团队上下文（或“无团队”）；已有团队绑定保持固定。无团队会话主动发布到 Project 并确认后可显式绑定目标 Workspace；是否对他人可见由发布范围决定。
- **改后收益**：
  - 任何已登录员工哪怕未加入任何团队、或协作服务端暂时离线，也能立即完成 Agent 预检并新建、续接个人会话；
  - 个人试验过程只存本机、不制造 Project 噪音；需要协作时可按“完整定稿正文”或“仅共享状态与成果摘要”一键发布到 Project，也可随时“停止共享”（已同步部分保留只读并标注“已停止同步”）；
  - 多团队成员可在左栏流畅切换团队，“我的会话”始终按当前选中团队干净过滤。

---

## 2. 核心模型与全局不变量（Invariants）

以下不变量全栈强制遵守，任何阶段不得破坏：

1. **一套会话模型（Single Conversation Model）**
   - 个人会话与 Project 会话在底层是同一种本机会话实体，唯一差异在于是否关联了云端发布记录（`publishedProject`）及其同步开关（`shareStatus`）。
   - 个人会话与发布后的 Project 会话使用同一条本机执行与渲染管线，不维护第二套本地 Agent 执行引擎。
2. **团队上下文（`teamContext`）新建锁定与显式发布绑定**
   - 每条会话在**新建时**记录当时选中的团队上下文 `workspaceId: string | null`（某团队 UUID 或 `null` 表示无团队）；首条消息发送前允许在会话准备阶段调整，发出后锁定。
   - 在左栏切换当前 Workspace、或成员后续新加入团队，**绝不自动改写**既有无团队会话的 `workspaceId`；仅当用户**主动将一条无团队个人会话「发布到 Project」**并在弹窗确认时，随本次发布显式绑定目标 Project 所在的 Workspace 上下文。
3. **“我的会话”按当前选中团队严格过滤**
   - 左栏个人区“我的会话”**不展示跨团队全量列表**，而是严格按当前激活的团队上下文过滤：
     - 选中团队 `W` 时，仅显示 `workspaceId === W` 且属于当前账号、未处于当前Project活跃列表中的个人会话（或按原型在「个人」空间按目录分组显示）；
     - 未加入任何团队或主动切换至“无团队”筛选时，仅显示 `workspaceId === null` 且属于当前账号的个人会话。
4. **可见性严格隔离（Private by Default）**
   - 未发布到 Project 的个人会话（无论 `workspaceId` 是否绑定了某个团队），**绝不上传正文、简报或状态到云端**，**绝不出现在任何 Project 看板、成员会话列表或管理员统计中**。
5. **发布到 Project 的归属规则**
   - 已绑定团队 `W` 的个人会话：仅允许发布到团队 `W` 下当前用户为活跃成员且状态为 `active` 的 Project（不允许跨团队发布到团队 `W2`）。
   - 无团队个人会话（`workspaceId === null`）：支持用户**主动发布到自己所属任意团队下状态为 `active` 且为活跃成员的 Project**；弹窗显式提示“当前会话尚未绑定团队；发布后会同步绑定目标 Project 所在的 Workspace 上下文”，用户确认后同步绑定目标团队并发布。
6. **会话发布 / 停止共享期间身份连续**
   - 同一条会话从“仅本人个人会话”（含无团队或已绑定团队）发布到 Project、或从 Project“停止共享”退回仅本地继续时，其 `conversationId`、原生 Agent 会话 ID（`nativeSessionId`）、本机工作目录授权、代码检查点历史及消息队列必须**连续不断链**。

---

## 3. 跨卡接口对齐（`HC-239` × `HC-233`）

本节锁定 `HC-239` 与 [HC-233 统一设计](HC-233-项目记忆与团队知识读取.md) 在 `desktop/src/shared/local-execution-host.ts`、`packages/acp-runtime/` 与 `desktop/src/main/local-execution-coordinator.ts` 上的共同接口边界，确保两卡接口兼容、可顺序/并行推进。

### 3.1 `LocalExecutionScope` 与 `LocalAcpScope`

将原四元组中的 `workspaceId` 与 `projectId` 改为**可空**（以 `null` 明确表达无团队 / 未发布到 Project，禁止使用空串占位在前端契约传播）：

- [本地执行宿主契约](../../../desktop/src/shared/local-execution-host.ts)：
  ```ts
  export type LocalExecutionScope = {
    readonly accountId: string
    /** 所属团队上下文；null 表示“无团队”个人会话，新建时锁定（仅主动发布无团队会话到 Project 时随确认显式绑定）。 */
    readonly workspaceId: string | null
    /** 已发布关联的 Project；null 表示尚未发布或仅本地未共享会话。 */
    readonly projectId: string | null
    readonly conversationId: string
  }
  ```
- [ACP 运行时类型](../../../packages/acp-runtime/src/types.ts)：同步将 `LocalAcpScope` 演进为：
  ```ts
  export type LocalAcpScope = {
    readonly accountId: string
    readonly workspaceId: string | null
    readonly projectId: string | null
    readonly conversationId: string
  }
  ```

### 3.2 执行键、原生绑定与代码检查点键（剥离 `workspaceId` 与 `projectId`）

为保证“个人会话（含无团队会话）发布到 Project”以及“Project 会话停止共享”前后，运行中的 ACP 绑定、`nativeSessionId` 与 Git 检查点索引不丢失、不重新开新会话：

1. `localExecutionKey(scope)`（[local-execution-host.ts](../../../desktop/src/shared/local-execution-host.ts#L227-L229)）统一改为仅按全局唯一账号与会话 ID 计算：
   ```ts
   export function localExecutionKey(scope: LocalExecutionScope): string {
     return JSON.stringify([scope.accountId, scope.conversationId])
   }
   ```
2. `buildNativeBindingIdentity`（[native-binding.ts](../../../packages/acp-runtime/src/native-binding.ts#L13-L44)）接收 `scope: LocalAcpScope`，将原 `scope.workspaceId` 与 `scope.projectId` 从标识数组中移除（仅使用 `[bindingNamespace ?? "", scope.accountId, scope.conversationId, root, String(dev), String(ino), ...]`）。
   - *说明*：由于本系统 `conversationId` 均为全局唯一 UUID v4，按 `(accountId, conversationId)` 计算既保持账号隔离，又能让无团队会话（`workspaceId = null`）在发布到团队 Project 后继续命中同一条原生会话绑定；按 `AGENTS.md` 兼容性原则，当前尚未正式发版，不保留旧哈希回退读取。
3. `CodeCheckpoints.#scope`（[checkpoints.ts](../../../desktop/src/main/project-service/checkpoints.ts#L75-L77)）同步剥离 `workspaceId` 与 `projectId`，改为按 `[this.origin, scope.accountId, scope.conversationId]` 计算作用域哈希。
4. `resolvePrompt(scope, login, text, referenceIds)` 中的固定引用读取策略：
   - 团队知识引用（`knowledge:<knowledgeId>:<versionId>`）：只要 `scope.workspaceId !== null` 且仍在当前账号所属团队列表中，即可在**个人会话**（无需 `projectId`）读取并附带；无团队会话（`scope.workspaceId === null`）不允许携带团队知识引用。
   - 会话快照引用（`snapshot:<snapshotId>`）：需要有效的 `scope.workspaceId` 与 `scope.projectId`（个人跨会话引用自身历史直接走本地消息引用，云端快照引用依托对应 Project 成员权限，允许发布前显式指定来源 Project，或在 Project 会话内直接使用 `scope.projectId`）。

### 3.3 预留 `HC-233` 上下文与 MCP 装配扩展点

为避免后续 `HC-233` 实施时大改 `local-execution-coordinator.ts`，本卡在 `LocalExecutionCoordinatorOptions` 中先行定义窄接口扩展槽（具体实现留 `HC-233`，本卡提供默认空实现或无团队短路）：

```ts
export type LocalPromptContextResult = {
  /** 附加给 Agent 的参考文本块（如记忆条目、团队知识标题目录），不写入用户展示消息与云端原文。 */
  readonly contextBlocks: readonly LocalAcpPromptBlock[]
}

export type LocalExecutionContextAssembler = {
  /**
   * 在真实账号与会话上下文有效时组装本轮自动材料。
   * 当 scope.workspaceId === null 时协调器直接跳过调用，保证无团队会话零注入。
   */
  assembleTurnContext?(input: {
    readonly scope: LocalExecutionScope
    readonly userText: string
    readonly directoryPath: string
    readonly turnId: string
  }): Promise<LocalPromptContextResult>
  /** 本轮成功/失败/取消结束时的收口钩子（供 HC-233 提交或丢弃本机记忆提案）。 */
  onTurnSettled?(input: {
    readonly scope: LocalExecutionScope
    readonly turnId: string
    readonly outcome: "completed" | "failed" | "cancelled"
  }): Promise<void>
}
```

- 协调器仅在 `scope.workspaceId !== null` 且 `login.workspaces.includes(scope.workspaceId)` 时调用 `contextAssembler`；当 `scope.workspaceId === null`（无团队）或用户已离开该团队时，**直接跳过**装配与知识注入。

---

## 4. 授权分离与离线执行流程

### 4.1 两条独立的授权链路

将原 `local-execution-coordinator.ts` 第 441～449 行的单一 `authorize()` 拆分为职责完全不同的两道校验：

```text
[本机执行链路：准备 / 发送 / 审批 / 追发 / 队列 / 检查点]
输入：scope（accountId, workspaceId, projectId, conversationId）+ 当前窗口身份 + 本地目录路径
  │
  ▼
判断（authorizeLocal，纯本机校验，不发任何云端网络请求）：
  1. 当前身份有效（已在线登录 signedIn，或本次应用会话已登录后断网进入离线续用态 connectionError + lastKnownUser）
  2. login.accountId === scope.accountId
  3. LocalConversationStore 中存在该账号的 conversationId 记录，且其 workspaceId 与 scope.workspaceId 一致
  4. 本机工作目录通过 LocalDirectoryGrantStore 硬件标识校验（realpath + dev/ino 一致）
  │
  ├─ 校验不通过 → 返回对应错误（FORBIDDEN / RESOURCE_NOT_FOUND / PROJECT_PATH_INVALID / PROJECT_ROOT_CHANGED）
  └─ 校验通过 ──→ 允许本地 ACP 会话创建/恢复与执行
                    │
                    ▼
                每轮成功终态（completed & shareable & !ephemeral）：
                  1. 必定先写入 LocalConversationStore（本机定稿持久化，失败明确提示）
                  2. 检查发布状态：是否已绑定 projectId 且 shareStatus === "active"？
                       ├─ 否（个人会话 / 已停止共享）→ 本轮结束，绝不触网、绝不入队上传
                       └─ 是（Project 活跃共享）─────→ 进入云端上传链路（不阻塞输入区）

[云端共享上传链路：发布 / 增量同步 / 补传 / 停止共享]
输入：已绑定的 (workspaceId, projectId, conversationId) + shareMode + 定稿轮次
  │
  ▼
判断（authorizePublishUpload，仅在联机且会话处于 active 共享态时执行）：
  1. 服务端有效登录态（signedIn）且当前账号仍属 workspaceId
  2. ConversationUploads 按当前 shareMode 组装载荷：
       - shareMode === "full"         → 上传定稿消息批次 + 简报摘要（brief）
       - shareMode === "summary_only" → messages 为空，仅更新 status 与简报结论摘要（brief）
  │
  ├─ 网络不可用 / 503 → 留在本机待传账本（uploads），本机对话照常可用，联网后自动续传
  ├─ 服务端返回 409 CONVERSATION_SHARING_STOPPED → 本地标记已停止同步并停止后续入队
  └─ 上传成功 ──────→ 推进本地 syncedSequence 水位，更新头部“已同步”状态
```

### 4.2 协作门面（`CollaborationState`）离线身份连续性

当前 [CollaborationState](../../../packages/collaboration-client/src/collaboration-state.ts#L160-L163) 在网络断开进入 `connectionError` 后，`personalIdentity()` 会立刻返回 `null`，导致“服务端不可用时已登录用户仍能新建并继续个人会话”无法通过 `isCurrent(login)` 校验。

因此，在 `CollaborationState` 中补充轻量“已认证本机快照”规则：

- **有效前提**：用户在本窗口进程内已通过真实 `signIn` 或 `getCurrentUser` 确认过身份（`signedIn`），随后因网络中断/服务端 503 转为 `connectionError`（`lastKnownUser !== null`），且尚未调用 `signOut()`、也未收到服务端明确的 `401 AUTHENTICATION_REQUIRED`。
- **行为定义**：
  - `personalIdentity()` 新增可选只读属性 `offline: boolean` 与 `lastKnownWorkspaces`（或保留 `workspaces` 并标记 `online: boolean`）：在上述断网续用态下，**继续返回当前已确认账号 ID 与本次登录已知的团队列表**（供本机执行、`LocalConversationStore` 和 `PersonalStore` 鉴权隔离使用）；
  - 凡涉及写云端的接口（`withWorkspace` / `applicationWorkspace` / `getProjectConversation` / 发布 / 停止共享 / 同步上传）在 `status !== "signedIn"` 时仍**严格拦截**并提示网络重连，绝不伪造云端成功；
  - 一旦用户主动登出（`signOut()`）或收到服务端 `401 AUTHENTICATION_REQUIRED`，立即递增 `generation` 并清空 `lastKnownUser` 及本机离线执行凭据，正在运行的本机绑定全部关闭清理。

### 4.3 离开团队与团队角色变化收敛

- 当 `getState()` / `getCurrentUser()` 刷新后发现账号 `workspaces` 不再包含团队 `W` 时：
  1. 属于 `W` 的历史个人会话记录在 `LocalConversationStore` 中**完整保留本机可见与可读**，且本机执行继续放行（仅不再向 `HC-233` 传递或注入 `W` 的团队知识与记忆，若会话原本已发布到 `W` 的某个 Project，自动把本地共享状态转为 `stopped` 并停止上传）；
  2. 左栏 Workspace 切换器移除 `W`，若当前停留在 `W`，自动回退到其余首个团队或“个人（无团队）”视图。

---

## 5. 本机个人会话独立存储（`LocalConversationStore`）

> 对应Task 待定问题 #2：采用**独立本机存储**，不把会话列表与定稿消息正文塞进现有的轻量 UI 状态存储 `PersonalStore`。

### 5.1 为什么不复用 `PersonalStore`

[PersonalStore](../../../desktop/src/main/personal-store.ts#L48-L49) 的单文件硬上限为 `1 MB`（安全裁剪阈值 `800 KB`），定位是保存窗口布局、滚动位置、输入框草稿与跨机会话的临时只读缓存；且它的权限模型要求每次加载校验远程权限。个人会话是长期沉淀在用户自己电脑上的完整对话账本与元数据索引，必须与轻量 UI 偏好分离。

### 5.2 存储目录与文件格式

由主进程新增 `desktop/src/main/local-conversation-store.ts` 管理，路径与权限延续桌面主进程安全约定（目录 `0o700`、文件 `0o600`、临时独占文件 + `rename` 原子替换）：

```text
<userData>/workbench/local-conversations/
  <originSha256>/                  # 与 PersonalStore 一致，按服务来源隔离
    <accountId>/                   # 32 位 hex userId，按账号严格隔离
      index.json                   # 当前账号全部个人/本机会话元数据索引
      conversations/
        <conversationId>.json      # 单条会话的本机消息正文、工具摘要与发布水位
```

- **`index.json` 单条元数据字段（`LocalConversationRecord`）**：
  - `conversationId`: UUID v4
  - `workspaceId`: `string | null`（新建时记录的团队上下文；无团队会话仅在主动发布并确认后显式绑定目标 Workspace，已有团队绑定保持固定）
  - `projectId`: `string | null`（当前或曾经发布关联的 Project ID；未发布过为 `null`）
  - `shareMode`: `"full" | "summary_only" | null`
  - `shareStatus`: `"local_only" | "active" | "stopped"`
  - `title`: string（1～80 字符；用户可重命名，首轮发送可按首条提问自动摘要生成默认标题）
  - `directoryPath`: `string | null`（绑定的本机工作目录）
  - `providerId`: `string | null`（绑定的本机 Agent Provider）
  - `status`: `"idle" | "running" | "waiting_approval" | "error"`
  - `createdAtMs` / `updatedAtMs`: number
  - `publishedAtMs` / `stoppedAtMs`: `number | null`
  - `syncedSequence`: number（服务端已确认水位，未发布为 `0`）
- **`conversations/<conversationId>.json` 单会话正文结构**：
  - `conversationId`: UUID
  - `nextSequence`: number（单调递增的本机消息序号基线）
  - `turns`: 数组，每轮包含 `turnId`、`sequenceStart`、`sequenceEnd`、`userText`、`referenceIds`、`attachments`、`images`（引用 `PersonalDraftImage` 元数据）、`followUps`、`tools`（`FinalizedToolSummary[]`）、`reply`、`status`（`"completed" | "cancelled" | "failed"`）、`failure`、`acceptedAtMs`、`completedAtMs`。

### 5.3 容量上限、裁剪与失败保护

- **单会话正文文件软/硬上限**：单条会话文件超过 **4 MiB** 时，写盘前按最旧轮次顺序折叠保留每轮 `userText`（前 240 字）与 `reply` 摘要（前 400 字）并移除旧轮 `tools` 明细，标置 `historyTrimmed: true`，确保文件始终 ≤ 4 MiB；最近 20 轮永远完整保留不被裁剪。
- **数量上限**：单个账号索引最多保留 `500` 条会话元数据（新建超出时提示归档或清理最旧空会话，不静默删除已有对话）。
- **原子写入与损坏恢复**：所有写入采用 `tmp + wx + rename`；读取解析失败或磁盘写满时，**保留原有已落盘文件**，向渲染进程返回可读错误并拒绝覆盖损坏文件。

### 5.4 `PersonalStore` 同步兼容扩展

[personal.ts](../../../desktop/src/shared/personal.ts) 与 [personal-store.ts](../../../desktop/src/main/personal-store.ts) 中的键与 Schema 同步演进，使个人会话也能持久化草稿、滚动位置、已展开工具卡片及右侧本机文件面板状态：

- `PersonalKey`：
  - 新增 `{ kind: "workbenchAccount" }` 或在 `AccountPersonal` 中保留 `workspaceId: string | null`（另增 `activeView: "workspace" | "solo"` 表示多团队账号是否主动切到无团队个人视图）；
  - `conversation` / `sessionWorkspace` 中的 `workspaceId` 与 `projectId` 改为 `string | null`（Schema 中对应 `nullableId`）；
  - `ProjectNavigationPersonal` / `ProjectDraftPersonal` 继续仅用于已选团队且已选 Project 场景。
- `PersonalStore` 对话权限核对：当 `key.projectId === null` 时，不再请求 `getProjectConversation`，改为由主进程校验 `login.accountId` 与 `LocalConversationStore` 中的本机归属。

---

## 6. 全栈共享契约与服务端规格

> 本卡已拍板全栈实施，统一在 `contracts/`、`server/` 与 `packages/collaboration-client/` 推进，严守 `server/src/main/resources/db/schema.sql` 建表规范与 `Foundation.java` 启动校验。

### 6.1 数据库与启动期结构核对

在 [schema.sql](../../../server/src/main/resources/db/schema.sql#L161-L182) 的 `wb_conversation` 表末尾新增 **3 列**（遵守：全列 `NOT NULL`、`TINYINT UNSIGNED` 从 `1` 起编、`DATETIME(3)` 毫秒精度，不使用 `CURRENT_TIMESTAMP`）：

```sql
share_mode TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '共享档位：1=full(完整定稿正文),2=summary_only(仅共享状态与成果摘要)',
share_status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '共享状态：1=active(持续同步),2=stopped(已停止共享)',
stopped_at DATETIME(3) NOT NULL COMMENT '停止共享时间(未停止时取created_at基线)'
```

同步更新 [Foundation.java](../../../server/src/main/java/workbench/collaboration/infrastructure/contract/Foundation.java#L68)：将 `share_mode`、`share_status`、`stopped_at` 加入 `REQUIRED_COLUMNS` 的 `wb_conversation` 必须存在列清单。

### 6.2 线上 JSON Schema、OpenAPI 与 TS 客户端类型

变更涉及：[organization.schema.json](../../../contracts/schema/organization.schema.json)、[organization.openapi.json](../../../contracts/openapi/organization.openapi.json)、[organization.ts](../../../packages/collaboration-client/src/types/organization.ts) 与 `collaboration-client.ts`：

1. **新增枚举类型**：
   - `ConversationShareMode = "full" | "summary_only"`
   - `ConversationShareStatus = "active" | "stopped"`
2. **扩展 `ConversationSummary`**：
   - 新增必选字段：
     - `shareMode: ConversationShareMode`
     - `shareStatus: ConversationShareStatus`
     - `stoppedAt: string | null`（UTC 毫秒时间戳；当 `shareStatus === "active"` 时为 `null`，当 `shareStatus === "stopped"` 时返回 `stopped_at`）
3. **扩展 `ConversationRegisterRequest`**：
   - 新增可选字段：
     - `shareMode?: ConversationShareMode`（省略时默认 `"full"`）
     - `initialBrief?: SyncBrief`（发布已有个人会话时，允许在登记会话头的同时写入初始进展/成果摘要与状态，使成员立即可见摘要而非空简报）
4. **新增停止共享接口**：
   - `POST /api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/stop-sharing`
   - 请求体：`{}`（或可选 `{ "requestId": Id }`，空对象校验 `additionalProperties: false`；停止共享本身天然幂等）
   - 响应：`200 OK`，返回 `ConversationDetailResponse`（内含更新后的 `shareStatus: "stopped"` 与 `stoppedAt`）
   - 权限与幂等规则：
     - 校验 `requireProject(workspaceId, projectId)` 与 `requireActiveMember(projectId, userId)`（非活跃成员一律 `404 RESOURCE_NOT_FOUND`）；
     - 校验会话属于当前 Project 且 `requireConversationOwner`（非创建者返回 `403 CONVERSATION_FORBIDDEN`）；
     - 若项目已归档，仍允许所有者执行停止共享（确保隐私止损优先于归档只读）或按既有策略处理——本 Spec 明确：**停止共享不阻断于项目归档态**；
     - 首次置为 `stopped` 时写入 `stopped_at = now`、`updated_at = now`，并发布既有 `conversation.brief_updated` 通知；若已处于 `stopped`，**幂等返回 `200`**（保留原 `stopped_at` 不重复发通知）。

### 6.3 两种共享档位与历史补传的行为契约

1. **`shareMode === "full"`（完整定稿正文）**
   - 正常从 `POST .../sync` 递增上传消息与简报。
   - **发布历史策略（Spec 待定项 #1 默认设计）**：从“我的会话”把已有个人会话发布到 Project 时，弹窗默认选中**“仅同步发布后的新对话”**，同时提供可勾选选项**“一并带入历史定稿消息”**（支持选“全部已定稿轮次”或“从第 N 轮起”）。
   - 若勾选带入历史：桌面先调用 `register` 拿到云端 `conversationId`（若桌面允许保留本机 UUID 还是映射云端 UUID？注意：`register` 目前由服务端 `UUID.randomUUID()` 生成云端 `conversationId`，因此桌面需在 `LocalConversationStore` 记录 `cloudConversationId`，或扩展 `ConversationRegisterRequest` 允许客户端传可选 `conversationId`？**采用后者更简洁**：若 `ConversationRegisterRequest` 支持可选 `conversationId?: Id`，发布时即可复用原个人会话 `conversationId`，使所有本地 `scope` 与缓存零重映射；若该 ID 在同项目已存在且同 owner + 同 requestId 则幂等返回！若同 ID 已属其他项目或他人则返回 `409 CONFLICT`）。
   - 历史消息按每条不超过 `32 KiB`、每批不超过 `900 KiB` 经既有 `POST .../sync` 分批顺序上传；本地超过 `32 KiB` 的超长历史轮次在预览弹窗提示超限并将按截断提示/仅同步摘要处理。
2. **`shareMode === "summary_only"`（仅共享状态与成果摘要）**
   - 桌面只上报 `brief`（包含 `status`、阶段进展与成果总结摘要，可由规则提取每轮用户诉求 + 最终结论生成，也可由用户发布前手动编辑）及涉及仓库列表，**绝不上送任何对话消息正文或工具明细**。
   - 服务端硬门禁：当 `conversation.shareMode === "summary_only"` 时，若 `POST .../sync` 请求体中的 `messages` 数组长度 `> 0`，服务端直接返回 `400 INVALID_REQUEST`（错误信息：`当前会话仅共享状态与成果摘要，不允许上传对话正文。`）；`GET .../history` 对任何人始终返回 `{ conversationId, syncedSequence: 0, messages: [] }`。
   - 如用户后续想从 `summary_only` 升级为完整共享，当前版本需通过“新建/复制发布”或另行明确授权操作，不在本卡隐式切换档位（保证“一旦选了仅共享摘要，绝对不会意外把试错正文上传上去”）。
3. **停止共享后的终态行为**
   - 一旦服务端将 `shareStatus` 置为 `"stopped"`：
     - 后续任何对该 `conversationId` 的 `POST .../sync` 均返回 `409`（错误码 `CONVERSATION_SHARING_STOPPED`）；
     - 原先已上传的历史消息、简报及已生成的 `wb_snapshot` 固定快照**完整保留只读**，Project 成员仍可查看与引用；
     - `ConversationSummary` 返回 `shareStatus: "stopped"` 与 `stoppedAt`，客户端展示“已停止同步”徽标；
     - 会话在所有者本机仍保留完整历史，可继续本地对话（不再触发云端入队）。

---

## 7. 桌面端 UI 与交互规格（对齐方案 B 原型）

所有视觉布局、间距、徽标语义与弹窗层级参照 [个人与团队协同工作台交互原型（方案 B）](../previews/personal-team-workbench/README.md) 实现，并复用现有 `@workbench/ui` 组件体系（不整体重画中央对话区与右侧文件/变更面板）。

### 7.1 登录即用与离线续用入口

1. **取消团队前置拦截**：
   - 登录成功后（或断网但本次进程已确认过身份时），无论用户是否加入团队、服务端是否暂时离线，**立即进入工作台主界面**，不再出现“当前账号未加入团队”阻塞空白页。
2. **首次 / 无可用 Agent 连通性预检引导**：
   - 当首次进入个人工作台或准备新建会话时，调用 `localExecution.listProviders()` 检查本机可用 ACP Agent（并结合模型配置可用性检查）：
     - 若存在至少 1 个可用 Agent：记住上次首选 Provider，默认直接选中，不额外弹窗打断；
     - 若全部 Provider 不可用（未安装可执行文件 / 启动探测失败 / 未配置模型）：在中央引导区或准备页渲染清晰的内嵌预检卡片，逐项列出各 Agent 检测状态、具体不可用原因（如“未检测到可执行命令”）与“重新检测”按钮，并保留打开系统设置入口。
3. **离线提示条（非阻塞）**：
   - 当身份门面处于 `connectionError`（但已有本次登录确认账号）时，顶栏/团队区显示轻量化“协作服务暂不可达 · 本机个人会话可正常使用”状态指示与“重连”按钮；左栏“我的会话”及本机会话输入、发送、目录选择与代码检查点全部正常可用。

### 7.2 左栏双轨与多团队切换（对齐方案 B 单层纵向侧栏）

严格参照 [方案 B 交互原型](../previews/personal-team-workbench/README.md) 左侧边栏（`264px` 单层纵向结构）改造 [ProjectNavigation](../../../desktop/src/ui/navigation/index.tsx)：

1. **顶部「个人 | 团队」双轨空间分段切换器（`space-sw-h`）**：
   - **「个人」Tab**：承载当前登录账号下的私有个人会话入口与列表；
   - **「团队」Tab**：承载团队 Workspace 切换、看板、团队知识与已发布到 Project 的协作会话；有队友会话更新或待处理协作事项时在「团队」Tab 右上角显示小圆点提示。
2. **「个人」空间结构（常驻个人会话，按当前团队上下文过滤）**：
   - 顶部主 CTA `+ 新建个人会话` + `⌘K` 快捷搜索入口；
   - 列表头「个人会话」右侧展示当前团队上下文筛选器（随当前 Workspace 或“无团队”切换同步更新，遵循第 2 节不变量 #3：**不展示跨团队“全部”，只显示所属当前选中团队或“无团队”的个人会话**）；
   - 会话列表按**本机工作目录（`directoryPath`）折叠分组**，每条会话项展示标题、状态指示（运行中 / 待审批 / 个人私有锁图标）；
   - 新建个人会话时自动绑定当前选中的团队上下文（无团队态下绑定 `null`），首条消息发送前允许在准备区/头部调整，发出后锁定，仅存本机，不调用任何 Project 登记接口；
   - 底部提示行：`另有 N 个会话已发布，在「团队」空间里`（当当前团队下存在已发布到 Project 的本人会话时显示）。
3. **「团队」空间结构（Workspace 切换 + Project 分组）**：
   - 顶部提供**多 Workspace 下拉切换器**（列出所属全部团队及成员数），支持在同一个桌面壳内直接切换不同 Workspace，切换后同步刷新该团队下的 Project、团队知识与「个人」空间对应团队的会话过滤结果；
   - 未加入任何团队时，「团队」空间显示友好的空态说明（“当前账号未加入团队，可在个人空间继续使用本机 Agent”）与「回到个人空间」主按钮；
   - 加入团队后展示团队功能导航（看板 / 团队知识）与按 **Project 折叠分组** 的「协作会话」：
     - Project 内的 `+ 新建 Project 会话` 默认在本地创建并**同时登记/发布到当前 Project**（头部显著显示 `Project 可见 · 持续同步`）；
     - 每个 Project 分组下依次呈现本人在该 Project 发布的会话与队友发布的只读会话（未发布的个人私有会话绝不混入）；若某条队友会话的 `shareStatus === "stopped"`，状态条与会话内提示显著显示**“对方已停止共享 · 保留已同步内容（只读）”**。

### 7.3 会话头部状态、发布到 Project 与停止共享交互

严格对齐方案 B 原型 `sessionMeta` 与发布/停止共享弹窗流转：

1. **会话头部状态芯片（`sessionMeta`）**：
   - **团队上下文芯片**：未发送首条消息前可点击下拉切换所属团队或“无团队”；首条消息发出后显示锁图标并锁定显示 `团队：<团队名>` 或 `无团队（仅本机）`；
   - **可见性芯片**：显示 `仅本人`、`Project 可见 · <项目名>（完整正文）`、`Project 可见 · <项目名>（仅共享摘要）` 或 `已停止同步 · 仅本机保留`；
   - **头部右侧主动作**：
     - 个人未发布会话（**无论是已绑定团队还是无团队**，只要当前账号有可访问的活跃 Project）：显示 `发布到 Project…` 按钮；若当前账号尚未加入任何团队或没有任何活跃 Project，悬停/点击提示“加入团队并创建/加入活跃 Project 后可发布”；
     - 已处于 `active` 共享状态的 Project 会话：显示 `停止共享` 按钮。
2. **“发布到 Project…”弹窗**：
   - **可选目标 Project 过滤（`publishTargets`）**：
     - 若会话已绑定团队 `W`：仅列出团队 `W` 下用户是活跃成员且状态为 `active` 的 Project；
     - 若会话尚未绑定团队（`workspaceId === null`）：列出当前账号所属各团队下用户是活跃成员且状态为 `active` 的 Project，并渲染醒目提示条：**“当前会话尚未绑定团队；发布后会同步绑定目标 Project 所在的 Workspace 上下文。”**
   - **选择共享档位（单选）**：
     - `完整定稿正文`：同步定稿用户提问、助手回复、工具摘要与简报；勾选框（默认不勾选）：`一并带入发布前已定稿的历史轮次`；
     - `仅共享状态与成果摘要`：仅同步会话运行状态、阶段进展与成果结论摘要（可编辑摘要文本），不上传对话正文与工具试错明细；
   - **安全与确认**：必选勾选框“我确认向目标 Project 成员共享本会话（已被他人同步的内容无法收回）”，留好与 `HC-249` 发布前敏感信息扫描的接入钩子；
   - **发布后转场**：确认发布成功后，会话保持当前选中与打开状态，左侧栏自动从「个人」空间切换至「团队」空间并展开目标 Project 分组，顶部提示“已发布到 <项目名> · 已切到团队空间并停留在本会话”。
3. **“停止共享”确认弹窗**：
   - 明确说明：“停止共享后，本机后续对话不再上传到 <项目名>；已经上传到项目的内容将作为只读记录保留，并标注‘已停止同步’，已被他人同步的内容无法收回。”
   - 确认后调用 `stop-sharing` 接口，更新本地 `LocalConversationStore` 为 `stopped`，左侧栏自动从「团队」空间切回「个人」空间并保留当前会话打开（本机输入框继续可写），提示“已停止共享 · 已切回个人空间并停留在本会话”。

---

## 8. 错误语义与边界条件汇总表

| 场景 / 条件 | 端侧表现与 HTTP / IPC 语义 | 预期收敛状态 |
| --- | --- | --- |
| 未加入任何团队的账号登录 | 正常进入工作台，默认停在「个人」空间，「团队」空间展示空态说明 | 可新建并完成多轮无团队本机个人会话 |
| 本机已登录期间协作服务端离线/503 | `CollaborationState` 保持 `lastKnownUser`，不踢回登录页 | 本机个人会话新建与执行照常；发布/停止共享/云端同步提示网络不可用，已发布待传留本机排队 |
| 无可用 ACP Agent 时尝试新建/发送 | 预检引导显示具体不可用原因，支持切换或重试 | 不崩溃，不伪造响应 |
| 无团队会话主动发布到团队 Project（有可用活跃 Project） | 弹窗列出当前账号可访问的活跃 Project 并明确提示将同步绑定目标 Workspace | 用户勾选确认后绑定目标 Workspace 上下文并发布成功，左栏切入「团队」空间 |
| 无团队会话（且未加入任何团队或无可用 Project）尝试发布 | 弹窗/提示说明“当前没有可发布的目标 Project，请先加入团队或创建项目” | 会话保持本地私有 |
| 团队 A 绑定会话尝试发布到团队 B 的 Project | 桌面端过滤不展示团队 B 项目；若绕过调用则被服务端 Project/Workspace 校验拒绝（`404`） | 会话保持原状 |
| `summary_only` 会话试图通过 `POST .../sync` 上传 `messages` | 服务端返回 `400 INVALID_REQUEST` | 试错正文绝不落库、绝不被队友拉取 |
| 非会话所有者调用 `stop-sharing` | 服务端返回 `403 CONVERSATION_FORBIDDEN` | 分享状态不变 |
| 重复点击或网络重试调用 `stop-sharing` | 服务端幂等返回 `200 ConversationDetailResponse`（保留首次 `stoppedAt`） | 前端正常收敛至“已停止同步” |
| 会话停止共享后再次触发定稿上传 | 服务端返回 `409 CONVERSATION_SHARING_STOPPED` | 桌面停止该会话后续入队，本机执行不受影响 |
| 成员被移出团队 W 或移除后离线重连 | 属于 W 的本地个人会话仍可读与本机续聊；`contextAssembler` 不再被触发；已发布的 W 项目会话在本地置 `stopped` | 不丢失本人本地历史，同时切断 W 知识注入 |
| 切换登录账号或点击登出 | 清空内存绑定、关闭 ACP 子进程、丢弃迟到异步结果 | 新账号只看到自己隔离目录下的会话与草稿 |
| `LocalConversationStore` 写盘失败（如磁盘满） | 保留旧文件原子不破坏，返回显式失败提示 | 不静默丢消息，用户可重试或另存 |

---

## 9. 必要冒烟与可观察验收清单

本规格实现完成后的真机冒烟需逐项观察以下可验证结果（与 [HC-239 Task](../task/HC-239-个人优先使用本机Agent.md#L12) `acceptance` 一一对应）：

1. **未入团登录即用 + 预检**：使用未加入任何 Workspace 的账号登录桌面，完成本机 ACP Agent 连通性预检（含至少一次模拟不可用与恢复重试演示），选择本机目录后完整走通一轮对话。
2. **服务端离线继续**：登录后断开或停止本地协作服务端，已登录用户仍可从左栏「个人」空间新建、打开个人会话并完成一轮本机对话；恢复服务后，此前已发布的 Project 会话自动补传积压定稿。
3. **团队上下文过滤与不串门**：使用同时加入团队 A 与团队 B 的账号，在团队 A 下建个人会话 `S_A`、在团队 B 下建个人会话 `S_B`；切换团队时，「个人」空间在团队 A 仅显示 `S_A`、在团队 B 仅显示 `S_B`；用同团队另一成员账号登录查看项目看板与成员列表，确认 `S_A`、`S_B` 均不可见。
4. **个人会话发布到 Project（含无团队 & 两档）与不断链**：
   - 将个人会话 `S_1` 以“仅共享状态与成果摘要”发布到 Project：队友账号可见 `S_1` 的状态与成果摘要，点击同步历史消息为空且看不到试错过程；`S_1` 在原设备继续发下一轮时，同原生会话 ID 延续上下文且不把消息传给服务端。
   - 将个人会话 `S_2`（含无团队会话显式绑定目标团队与同团队会话两种场景）以“完整定稿正文”（含勾选/不勾选历史两路径）发布到 Project：发布后左栏切到「团队」空间并停留在原会话，队友账号可见简报并能拉取定稿正文；原设备继续对话，原生绑定与目录授权无需重新确认。
5. **停止共享**：对已发布会话执行“停止共享”，左栏切回「个人」空间并停留在当前会话，头部显示“已停止同步”并可继续本机对话（不再上传新轮次）；队友账号刷新后仍可只读查看已上传历史并明确看到“已停止同步”标注。
6. **回归检查**：全栈检查命令通过（`npm run typecheck`、`npm run build`、`npm run check:boundaries`、`npm run contracts:smoke`、Java 服务端测试与桌面单测）。

---

## 10. Spec 评审已确认裁定（2026-11-23）

下列在 [HC-239 Task 第 74～78 行](../task/HC-239-个人优先使用本机Agent.md#L74-L78) 登记的待定项已按如下方案收口，并已同步启动同名 Plan 与 Todo：

1. **发布到 Project 时对发布前历史的处理**：默认仅从发布后的新轮次起同步，发布弹窗提供显式勾选框允许“一并带入已定稿历史（可选全部或指定起始轮次）”；`ConversationRegisterRequest` 允许客户端传可选 `conversationId` 以实现全生命周期零重映射；**个人会话（含无团队会话）均可主动发布到有权限的活跃团队 Project**。
2. **个人会话本机存储位置与上限**：独立于 `PersonalStore`，新增 `<userData>/workbench/local-conversations/<originSha256>/<accountId>/` 下的 `index.json` + 单会话 JSON（单会话上限 4 MiB 自动折叠旧轮保留最近 20 轮完整，单账号上限 500 条）。
3. **UI 与交互参考基线**：严格参照 [方案 B 交互原型](../previews/personal-team-workbench/README.md) 的单层纵向双轨侧栏（`个人 | 团队`）、头部芯片及发布/停止共享弹窗流转开发，其中「个人会话」列表过滤严格遵守第 2 节已确认的按当前团队过滤规则。
