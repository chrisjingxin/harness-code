# HC-240 Workspace角色管理

状态：2026-11-23 统筹 lody 已审查通过，用户授权整卡实施；用户（本机）在 `harness_lody` 推进。行为来源为[同名 Task](../task/HC-240-Workspace角色管理.md)及[个人与团队协同用户旅程](../architecture/个人与团队协同用户旅程.md)第 3、7、15 节。

## 1. 用户结果与边界

现在团队成员没有角色，任何成员都能直接发布知识、登记仓库，也没有安全移除成员的入口。简单删除成员关系会遗留任务和负责人，并使历史产出的作者难以辨认。

改后，团队只有管理员和开发者两种角色。管理员在现有设置页管理成员、调整角色；移除成员时先看清需要交接的工作，再一次提交。服务端同时核对权限和最新数据，保证交接与移除一起成功或一起撤销。历史会话、快照、知识版本与贡献者保持原样，仍在团队中的有权成员可只读查看。

```text
管理员进入团队设置 → 服务端返回成员、角色与版本
  ├─ 修改角色 → 校验管理员资格、版本、剩余管理员 → 保存并刷新权限
  └─ 移除成员 → 展示全部待交接工作 → 选择接手人与必要的 Project 加入确认
                → 事务内重新核对 → 交接、停止原成员共享、撤销成员资格
                → 新负责人看到工作；原作者历史保留；原成员失去团队访问权
```

本卡全栈覆盖 `contracts/`、`server/`、`packages/collaboration-client/`、`desktop/`。沿用 Java、MySQL 兼容的 TDSQL、用户 Cookie/CSRF 和现有轻量 SSE（只传资源标识的通知流）。服务端不运行模型。UI 复用主题、字号、`wb-button`、现有设置页与弹窗；不重画中央对话或右侧文件面板。

不实施 HC-239 的个人会话/发布状态机、HC-233 的记忆算法、HC-241 的提议审核、HC-243 的系统地图、通用 ACP 或 Git 托管权限。下文仅约定它们消费本卡权限、成员状态与仓库负责人的接点。

## 2. 真实源码依据

核对基线：`6ed522781cfe8b2cb1894429ce362f3a2b5adb22`；派发时 HEAD 与 `origin/harness_lody` 一致，工作区干净。后续共享工作区修改须在实施前再核对。

| 当前事实 | 源码与影响 |
| --- | --- |
| 团队无创建者、角色或成员状态 | `server/src/main/resources/db/schema.sql` 的 `wb_workspace` 只有标识、名称和创建时间；`wb_workspace_member` 只有团队、用户、加入时间。不能从现有字段推断真实创建者 |
| 当前没有创建团队、添加团队成员的 HTTP 写入口 | `interfaces/rest/IdentityController.java` 与 `interfaces/http/RouteCatalog.java` 仅有团队/成员 GET；`infrastructure/contract/Foundation.java` 的 `initializeDemo/insertMissing` 初始化演示团队与五名成员 |
| 两套演示初始化路径需一起改 | `Foundation.java` 与 `db/demo-data.sql`；后者的 d1 是预置仓库登记者和一个 Project 的负责人，这不证明其是所有历史团队的创建者 |
| Project 的负责人和团队角色不同 | `wb_project.owner_user_id` 必填；`ProjectAccessPolicy` 检查 Project 活跃成员及 owner；成员移除保留 `removed` 行 |
| 仓库没有负责人 | `wb_repository.created_by_user_id` 是登记者，不是可转交职责；没有系统地图独立实体 |
| Task 不能待认领，也没有转交入口 | `wb_task.assignee_id` 必填；`TaskAppService` 仅有创建、编辑、状态流转和本人会话关联；未完结为 `todo/doing/review` |
| Task 发起人承担验收职责 | `TaskStatus.requireTransition` 中 `review → done/todo` 和取消由 creator 执行；仅换 assignee 无法解决发起人离职后的验收 |
| 当前知识保存即发布，任何团队成员均可写 | `KnowledgeAppService.create/edit/archive` 仅检查团队成员；还没有“待审核”对象或批准接口 |
| 通知已有事务发件箱与团队锁 | `NotificationStore.append` 锁 `wb_workspace` 行；`NotificationAppService.page` 每批检查成员资格；被移除者不能继续读该团队通知 |
| 桌面身份刷新不等于现有 `getState()` | `CollaborationState.getState` 对正常登录态返回本地缓存；需要增加真正请求 `/auth/me` 的刷新动作 |
| 知识缓存与工具已有失效接点 | `desktop/src/main/workbench-context/knowledge.ts` 有 `invalidate(workspaceId)`；`service.ts` 监听身份状态，但必须收到真实的新团队权限 |
| 可复用现有设置与成员展示 | `desktop-workbench.tsx` 的设置布局、`ui/identity/identity-panel.tsx`、`features/project-navigation/use-organization.ts`；当前没有团队管理表单 |

CodeGraph MCP/命令及 `.codegraph/` 索引在本工作区均不可用，本轮按仓库规则回退 `rg`/源码读取。已读 `openwiki/quickstart.md`，其内容仍描述已退役 CLI；实际边界以当前 README、架构总览和源码为准，未手改生成 Wiki。

## 3. 角色、成员与权限

### 3.1 两种角色及初始化建议

首版只设 `admin`（管理员）、`developer`（开发者），不增加高于管理员的所有者。当前没有团队删除、所有权转让等独立能力；多管理员和最后一名管理员保护已经覆盖本卡需求。创建者是历史事实，不是第三种权限角色。

新建团队的数据入口必须在同一事务写入创建者及其 `active/admin` 成员行。当前没有创建团队产品入口，本卡不额外扩展创建团队 UI/API；两条演示初始化路径显式指定工号 `80278667` 为新演示团队的创建者和首名管理员，其余人为开发者，不能因重复运行脚本而恢复已移除成员或覆盖已调整角色。

历史团队没有可信创建者数据，采用以下明确规则：

1. 有外部已核实创建者资料时，由受控初始化输入逐团队提供 `workspaceId → creatorUserId/adminUserId`；初始管理员必须是该团队现有、启用的成员。
2. 无法核实创建者时，创建者留空，运维显式指定至少一名现有、启用成员为初始管理员；其余成员为开发者。只确认管理员，不伪造创建者。
3. 不把所有成员设为管理员，不按最早加入、Project owner、仓库登记者或当前登录者自动提权。缺少映射、映射跨团队或无有效管理员时，初始化失败并列出团队标识，禁止带不完整权限数据上线。
4. 演示团队的已知映射只用于 demo，不用于其他团队。初始化只处理尚未初始化的数据；已有角色和历史移除记录不覆盖。

以上初始化规则已由统筹审查通过。保留数据的初始化与现行单份 DDL 原则见第 8 节。

### 3.2 权限矩阵

| 操作 | admin | developer | removed / 非成员 |
| --- | --- | --- | --- |
| 查看团队成员与角色、团队仓库、已发布知识 | 允许 | 允许 | 拒绝 |
| 添加团队成员、调整角色、移除和交接 | 允许 | 拒绝 | 拒绝 |
| 登记/修改/归档团队仓库、设置仓库负责人 | 允许 | 拒绝 | 拒绝 |
| 当前知识直接创建/改版/归档接口 | 允许 | 拒绝 | 拒绝 |
| 后续知识/地图提议 | 允许，HC-241/243 交付 | 允许，HC-241/243 交付 | 拒绝 |
| 后续批准/退回、直接编辑规约 | 仅 admin，复用本卡服务端策略 | 拒绝 | 拒绝 |
| 创建 Project | 允许 | 允许 | 拒绝 |
| Project 普通读写、会话/快照/Task | 仍须该 Project 活跃成员及既有角色 | 同左 | 拒绝 |
| 本人个人会话、本机 Agent 执行 | 沿用本人账号与本机授权 | 同左 | 团队退出不把执行权交给他人；个人使用见 HC-239 |

管理员不会自动加入全部 Project，也不获得任意读取其正文、接管会话或执行 Agent 的权限。离职交接接口是本卡明确的窄管理权限：可查看交接所需的 Project/Task 标识、标题、状态和负责人，不提供任务描述、会话正文、文件内容或任意 Project 管理能力。

当前知识写接口是发布接口，本卡将三条写路径改为实际检查 admin，并同步关闭开发者的直接发布入口。开发者保留阅读能力；UI 提示“团队知识由管理员发布，可联系管理员维护”，不以假提议或假批准代替。已发布版本不因降级、离职或权限检查改变正文、版本号、作者和发布时间。

### 3.3 成员状态与最后管理员

成员状态为 `active/removed`。移除保留成员记录、姓名关联、加入时间和离开时间，不删用户。重新加入须管理员显式操作，默认 developer；不会自动恢复原 Project 成员资格或已停止的共享。

“有效管理员”指 `active/admin` 且用户 `enabled=1`。降级/移除管理员时，事务内确认变更后至少一名有效管理员。两名管理员并发互相降级或移除时只能先完成一个操作，后一个收到 `LAST_WORKSPACE_ADMIN`。允许有其他有效管理员时降级或移除自己；成功后自身管理表单立即关闭。

全局账号停用目前没有业务管理入口；不把外部 DBA 直接改表视为本卡可拦截的事务。初始化检查不得留下无有效管理员的团队；若外部停用导致该状态，给出需运维修复的明确诊断，不自动提升普通成员。

## 4. 接口与契约增量

所有业务响应沿用 BeeResponseEntity；所有写请求继续使用用户 Cookie、CSRF、固定 Origin 和协议版本头。请求和响应使用封闭 JSON Schema（不接受未声明字段），ID 沿用现有 UUID/UserId 格式。同步更新 OpenAPI、Java DTO、RouteCatalog、TS 类型、客户端解码与 fixtures，不保留旧角色形状的 alias/fallback。

### 4.1 类型变化

| 类型 | 新增/明确字段 |
| --- | --- |
| `WorkspaceRole` | `admin \| developer`，仅 Workspace 使用；ProjectRole 保持 `owner \| member` |
| `WorkspaceSummary` | 原字段 + 当前用户的 `role`、`memberVersion`、团队 `accessVersion`；只列当前活跃团队 |
| `MemberSummary` | 原 `user` + `role/status/enabled/version/joinedAt/leftAt`；removed 的 leftAt 非空，active 为 null |
| `MembersResponse` | 原字段 + `accessVersion`；列表保留 removed/停用成员的最小身份资料，供历史作者标注；加入与交接候选只取 active 且 enabled |
| `WorkspaceAccess` | `workspaceId/role/memberVersion/accessVersion`；服务端最新权限快照，不是授权令牌 |
| `RepositorySummary` | 新增 `ownerUserId: UserId \| null`、`version`；`createdByUserId` 不变。null 显示“待认领” |
| `RepositoryCreateRequest` | 可选 ownerUserId；省略时负责人取当前管理员，显式 null 为待认领 |
| `RepositoryPatchRequest` | 新增 ownerUserId 和必填 expectedVersion；现有调用方一起迁移 |
| `TaskTransition` | 增加 `reassigned` 类型及必填 handoff 字段：该类型为 `{fromAssigneeId,toAssigneeId,previousConversationId}`，其他类型为 null；保留原状态、操作人、时间与说明 |

会话、快照和知识历史作者的“已离开”属于当前成员状态的展示投影，不写进不可变正文。统一用含 tombstone（保留的移除记录）的团队成员字典解析 owner/creator/author/sourceOwner；同一用户若仅离开某个 Project，沿用“已离开项目”，移出团队则优先显示“原成员已离开”。所有历史作者 ID 不替换为接手人。

### 4.2 路由

以下路径以 `/api/v1/workspaces/{workspaceId}` 为前缀。

| 方法与路径 | 输入 | 输出与权限 |
| --- | --- | --- |
| `GET /access` | 无 | WorkspaceAccess；活跃成员可读，移出即拒绝 |
| `GET /members` | 无 | 扩展 MembersResponse；活跃成员可读 |
| `POST /members` | `{userNo, requestId}` | 加入/重新加入已有启用账号，默认 developer；仅 admin。用工号精确查找，不新增全员目录搜索或身份创建 |
| `PATCH /members/{userId}/role` | `{role, expectedVersion, requestId}` | 最新 MemberSummary + accessVersion；仅 admin，校验最后管理员 |
| `GET /members/{userId}/removal-preview` | `afterId? / limit? / previewVersion?` | 完整交接预览的分页；仅 admin，细节见第 5 节 |
| `POST /members/{userId}/removal` | WorkspaceMemberRemovalRequest | 成功回执：被移除成员、交接数量、最新 accessVersion 与 requestId；仅 admin |

新增主机具名方法 `refreshIdentity/getWorkspaceAccess/addWorkspaceMember/changeWorkspaceRole/previewWorkspaceRemoval/removeWorkspaceMember`；不开放任意 URL/方法/载荷透传。刷新身份必须实际请求 `/auth/me`，不能把缓存 `getState()` 当作刷新。成员、角色、交接 IPC 继续使用可信窗口、参数数量和形状守卫。

新增请求/响应定义放入 `platform.schema.json`，名称为 `WorkspaceMemberAddRequest/WorkspaceRoleChangeRequest/WorkspaceMemberChangeResponse/WorkspaceRemovalPreview/WorkspaceMemberRemovalRequest/WorkspaceMemberRemovalResponse`。成员加入与角色修改统一返回 `{member, accessVersion}`。预览的 `items` 是按 kind 区分的 task/project/repository 封闭联合类型：

- task：taskId、projectId、title、status、version、creatorId、assigneeId、conversationId、duties（assignee/creator 的去重数组）、archived；同一 Task 只出现一次。
- project：projectId、name、status、version、ownerUserId、targetIsOwner、targetIsMember；包含目标有成员身份或责任的项目，以及第 5.2 节需要修复无效 owner 的相关项目。
- repository：repositoryId、name、status、version、ownerUserId。

顶层附 `workspaceId/targetMember/accessVersion/effectiveAdminCount/previewVersion/items/nextAfterId/counts/projectEligibility`。counts 对三种对象及待转交/只读历史分别计数；projectEligibility 给相关 Project 的 `projectId/activeSuccessorUserIds`，团队候选的名字与 enabled 来自成员列表，不回传其他 Project 正文。previewVersion 限 64 位小写十六进制，分页 afterId 限 kind 与已有业务 ID 的组合；版本和计数限非负安全整数，修改用 expectedVersion 至少为 1。提交响应为 `{workspaceId, member, accessVersion, requestId, transferredTaskCount, transferredProjectCount, transferredRepositoryCount, unclaimedRepositoryCount, stoppedConversationCount}`。

角色/加入请求体上限 16 KiB，移除提交 64 KiB；预览分页默认 50、最大 100 项。已有团队成员列表的 1000 人上限保持不变，含历史记录达到上限时明确拒绝添加新的用户，重新激活已有记录不增加人数。预览不能静默截断责任对象；游标使用稳定的 `对象类型 + 业务ID` 顺序，Schema 和 RouteCatalog 同时声明合法查询参数。

用户不存在、停用或不在可选范围统一返回 `TARGET_UNAVAILABLE`，不借添加入口暴露账号详情。已经 active 的成员重复添加返回现状，不覆盖原角色；重复 requestId 必须匹配相同动作和载荷。

## 5. 移除预览与交接规则

### 5.1 预览展示什么

预览由服务端从真实关系生成，包含目标成员及版本、accessVersion、有效管理员数、全部对象分类计数、分页 items、nextAfterId 和 `previewVersion`。previewVersion 是对团队/目标/操作者及相关资格和责任清单生成的 SHA-256 摘要，用于判断用户确认的资料是否已经变化，本身不授予权限。

清单包含：

- 活跃 Project 下该成员为 assignee 的全部 `todo/doing/review` Task，显示标题、状态、当前版本、关联会话，以及交接后将变为“待接收”的说明。
- 活跃 Project 下该成员为 creator 的未完结 Task；若不是同一条执行责任则单独标明“发起/验收职责”，不冒充原作者转名。
- 该成员负责的活跃 Project，以及该成员在其他 Project 的活跃成员身份。
- 该成员负责的活跃团队仓库；归档 Project/仓库及其中未完结 Task 单列为“已归档，保留历史”，不借交接解档。
- 已发布会话数量和贡献保留说明；不在预览下载正文。

每页带相同预览版本；加载后续页时提交 previewVersion，版本不符返回 `HANDOFF_PREVIEW_STALE` 并要求重新读取。确认提交前必须成功读完所有页。查询失败显示“交接清单未能读取”，不能显示为“没有工作”。

### 5.2 接手人和待认领

批量选择一个默认接手人，允许逐 Project、Task、仓库覆盖。候选必须是同 Workspace、active、enabled，且不是待移除人。默认优先显示已在对应 Project 的人；不按成员名称猜测身份。

| 对象 | 交接结果 | 限制 |
| --- | --- | --- |
| 未完结且由离职者执行的 Task | assignee 换为接手人，version +1，状态置 todo（待接收），当前 conversationId 清空；写 reassigned 历史 | 当前模型不允许空 assignee，必须选人；新负责人在本机主动接收，不自动执行 |
| 离职者作为 creator 的 Task | creatorId 原样保留；其后编辑/取消/验收职责由该 Task 所在 Project 的当前有效 owner 代管 | 只在 creator 已移出团队或已停用时启用该窄规则；原 creator 仍在时不扩大 owner 权限 |
| 活跃 Project owner | ownerUserId 换为接手人，Project version +1 | 不支持待认领；必须存在一名实际 Project 活跃成员作为负责人 |
| 活跃仓库 owner | ownerUserId 换为接手人或 null，version +1 | null 明确显示待认领；不改变登记者、远端地址或 Git 权限 |
| 已归档对象 | 保留原历史归属及离开标注 | 后续 HC-250 解档时须核对有效负责人，不在本卡偷偷修改归档对象 |

Task 的旧会话仍保留 `ownerUserId` 和历史 taskId 关系，作为只读来源；旧 conversationId 记入 reassigned 记录。新接手人以后只能关联自己创建的新会话。原 Task 引用的固定快照、知识版本、讨论及提交记录不删除。将 doing/review 重置为 todo 是显式交接动作，确认页逐条展示，不在后台暗改。

若接手人尚不在某个 Project，默认拒绝；管理员可在交接预览中逐 Project 明确勾选“把接手人加入该 Project，可读取其已共享内容”。提交 `addToProjects` 的精确 Project/用户配对，服务端仅为本次有责任交接的 Project 添加相应接手人，不添加任意旁人或扩大至其他 Project。这是独立的离职交接管理权限，不改变一般 Project 成员管理仍由 owner 执行的规则。界面不能默认勾选或只弹一句笼统确认。

creator-only Task 的 Project owner 若也是离职者，必须先在同一提交中指定该 Project 的新 owner；若已有 owner 已停用/不在团队，预览标出阻塞，要求在本次交接清单内修复该 Project owner。不能让移除成功后仍无人验收。

### 5.3 提交载荷与覆盖

WorkspaceMemberRemovalRequest 包含：

```text
requestId、expectedMemberVersion、previewVersion
defaultSuccessorUserId（UserId 或 null）
projectSuccessors[]（projectId、userId）
taskSuccessors[]（taskId、userId）
repositorySuccessors[]（repositoryId、userId 或 null）
addToProjects[]（projectId、userId；明确确认的新增 Project 阅读权）
confirmResetTasks: true、confirmRetainHistory: true
```

服务端从当前责任集合展开“默认值 + 覆盖”，不能相信客户端声称已经交接完。重复 ID、额外/跨团队对象、未覆盖的必填责任、同离职者的接手人或越界的 Project 加入项均拒绝。仓库使用默认值时可以为 null；Task、Project 的解析结果必须有人。

预览摘要覆盖目标成员版本、团队 accessVersion、所有相关成员 enabled/状态、管理员集合、Project 版本/状态/owner/成员资格、Task 版本/状态/责任人、仓库版本/状态/owner。包括新出现或已结束的责任对象，不能只校验用户交来的旧列表。

### 5.4 事务与并发保护

```text
固定团队行锁 → 从数据库重读操作者和目标资格 → 校验最后管理员
  → 核对 requestId/载荷回执 → 重新生成完整责任集合与预览摘要
  → 校验所有接手人、Project 加入确认与对象版本
  → 必要的 Project 加入、owner/Task/仓库转交
  → 停止原成员的共享、移除其 Project 成员身份、团队状态置 removed
  → 保存回执、交接历史、轻量通知 → 一次提交
```

使用 MySQL InnoDB 事务和 `SELECT ... FOR UPDATE`，所有相关写操作先锁同一 Workspace 行，再按稳定 ID 顺序锁/改 Project、成员和责任对象；不依赖进程内锁。角色、移除、Project 成员、Task 变化、仓库变化、知识发布及共享上传等相关写入口均遵守团队先行的顺序，使权限撤销和进行中的写操作有明确先后。原 `NotificationStore.append` 在事务末尾再锁团队行的调用点须核对并消除反向锁序。网络、模型、SSE 等待不得放在数据库事务内。

先提交的正常业务可以成为新预览的一部分；撤权事务提交后才获得锁的旧写请求必须重读当前资格并拒绝。不得仅在 HTTP 入口检查一次角色后拿旧判断继续提交。读请求每次读取当前数据库资格；已在撤权前被读取或发送出去的内容不能追回。

任何对象变化、接手人失效、角色撤销、最后管理员冲突或数据库写失败都整笔回滚。预览冲突返回 409 并保持成员在册，UI 保留选择草稿、重新预览后再确认，不能自动套用新责任清单提交。

成功回执与业务同事务持久化；相同操作者、团队、requestId 的相同动作/载荷重试不重复转交、重置或发通知，改载荷返回 REQUEST_ID_CONFLICT。回执重放前仍检查当前管理权限；自我移除后重试可能被拒绝，客户端通过真实 `/auth/me` 确认已不在团队，不重新执行，也不绕过成员限制读取旧回执。

## 6. 历史保留、权限撤销与页面刷新

### 6.1 原成员与留在团队的人

移除后原成员不再读取该团队的知识、仓库、Project、会话历史、快照、Task、看板或旧通知，即使 Cookie 尚未过期、知道资源 ID、保留页面或旧工具 token。服务器成员查询只认 active；现有 Project removed 行一并更新。降级仍是团队成员，可读原本有权的 Project 与知识，仅失去管理/直接发布权限。

移除时将该用户在团队下仍 active 的共享会话设为现有 `share_status=stopped`，保存停止时间；不伪造新的 HC-239 状态，不更改 owner、已有消息或同步水位。原用户继续本机个人会话不再向这个团队上传；接手人也不能上传到它或恢复其 Agent。重新加入团队不会恢复这些共享。

留下的 Project 成员仍按需读取既有共享历史与固定快照；标题旁显示“原成员已离开 / 已停止同步”。知识版本与贡献记录仍可读并标作者已离开，管理员可按正常版本机制继续维护条目，不能改写原版本。接手人的职责和原作者的贡献在 UI 分开显示。

原成员的本机个人会话和原始本机记忆文件不删除；撤销团队资料注入、工具访问和待写回提案。已读入历史或 Agent 上下文的内容无法收回，应沿用现有明确说明。停止注入与个人会话继续使用之间的边界由 HC-239/233 已有接口承接，不为移除新增远程停止 Agent 指令。

### 6.2 即时生效和失效事件

在现有 NotificationEvent 增加 `workspace.member_changed`；继续只携带 objectId（目标 userId）、projectId=null、时间和游标，不传角色、姓名或正文。该类型的 objectId 需按 UserId 校验，不能套用仅 UUID 的旧规则。存储列容纳现有 UserId；其他事件仍用各自的 ID 规则。

事件事务内写给其他有效团队成员；操作者用成功响应即时刷新。被移除者不能从团队流取得“最后一条通知”：现有服务每批核对成员，移除后会关闭旧流，不能为其放行旧通知。桌面主进程在收到该事件、SSE 重新连接/变为不可用、窗口重新激活、进入团队设置和管理写操作被拒绝时，真实刷新 `/auth/me`（响应含当前各团队的 role/memberVersion/accessVersion）；需要单个团队快照的消费方使用 `/access`。合并同轮刷新请求并丢弃旧范围的迟到结果，不以本地 getState 作权限确认。

刷新后：

1. 角色降级：关闭正在编辑的管理/发布弹窗，按钮与菜单随服务端新角色更新；未提交草稿可留本机，但不得继续发送管理请求。普通阅读保留。
2. 被移除：从团队列表和选择器移除该 Workspace；清空其成员、Project、看板、知识标题/正文页面缓存与待处理引用候选，取消其订阅；关闭团队管理页。本人会话持久内容保留，不自动绑定另一团队。
3. 主进程按团队维护权限修订号，使旧网络回包不能回填缓存；不要为了刷新角色递增全账号登录代次或取消别的团队的个人轮次。
4. 通过现有身份状态通知及知识失效接点，使 HC-233 下一次读取/写回重新核对团队资格；移出团队时旧工具授权和 pending 提案失效，降级不撤销正常知识阅读工具。
5. 切号/退出继续沿用原登录代次隔离，服务器 401 收回整个登录态；失去一个团队权限不能让其他团队和本人本机使用一起退出。

SSE 只订阅当前团队，因此未选中的团队变化在下一次进入、窗口激活或发送团队工具请求时复核。服务端请求始终即时拒绝，不能以 SSE 未送达为由继续授权。团队知识与本机记忆的下一轮装配/工具调用需要在线确认当前团队资格；确认不可用时暂停这部分资料与写回，普通个人发送按 HC-239 已有降级规则继续，不用缓存角色冒充最新权限。已启动的本机轮次不因页面刷新获得任何新团队权利。

## 7. 错误和可观察 UI

沿用已有 `AUTHENTICATION_REQUIRED`（401）、`WORKSPACE_MEMBER_REQUIRED`（403）、`RESOURCE_NOT_FOUND`（404）、`VERSION_CONFLICT/REQUEST_ID_CONFLICT`（409）和 Project/仓库归档错误。不得改变既有非 Project 成员读取资源时的 404 隐藏规则。

| 新错误码 | HTTP | 用户可见处理 |
| --- | --- | --- |
| WORKSPACE_ADMIN_REQUIRED | 403 | “此操作需要团队管理员权限”，刷新实际角色并关闭管理动作 |
| LAST_WORKSPACE_ADMIN | 409 | “团队至少需要一名有效管理员，请先设置另一名管理员”，成员仍在册 |
| TARGET_UNAVAILABLE | 409 | “接手人或目标成员已不可用，请刷新选择”，不泄露外部账号资料 |
| HANDOFF_PREVIEW_STALE | 409 | “工作或成员权限已变化，请重新查看交接清单”，不自动确认 |
| HANDOFF_INCOMPLETE | 409 | “仍有任务或项目需要接手人”，界面按最新预览定位缺项 |
| PROJECT_SUCCESSOR_CONFIRMATION_REQUIRED | 409 | “接手人尚不在该项目，请明确确认其阅读权限”，保持未提交 |
| WORKSPACE_MEMBER_LIMIT | 409 | “团队成员数量已达上限”，不截断名单或覆盖已有成员 |

团队设置展示姓名、工号、管理员/开发者、在册/已离开、本人标记。普通开发者能看名单与自己的角色，管理按钮不出现；管理员可按工号添加、修改角色和打开移除交接。最后一名管理员行禁用降级/移除并显示原因，但服务端仍独立校验。

交接弹窗先读预览再出现提交按钮，分组展示责任、全部分页数量和只读历史说明。批量接手人只填可用项，缺项醒目标注。Project 新增阅读权逐项确认；仓库允许选待认领，Task/Project 不显示不支持的空负责人选项。显示 Task 回到待接收、旧会话保持只读以及原成员会失去团队权限。提交中禁重复点击；真实成功响应后更新名单、职责与通知状态，失败时不先从列表删人。

## 8. 数据库、初始化与单一实现路径

实施只更新 `server/src/main/resources/db/schema.sql` 这一份 canonical DDL，并同步 PO、Mapper、领域对象、转换器和 `Foundation` 的启动只读核对。不引入 Flyway、启动自动 ALTER、双写旧成员表或第二份常驻 schema。

| 表 | 增量 |
| --- | --- |
| wb_workspace | creator_user_id（未知历史创建者为空串）、access_version（初始 1，成员加入/角色/移除时递增） |
| wb_workspace_member | role（1 admin / 2 developer）、status（1 active / 2 removed）、version（初始 1）、updated_at、left_at（active 时使用加入时间占位，API 映射 null）；增加团队/状态/角色查询索引 |
| wb_repository | owner_user_id（空串表示待认领）、version（初始 1）、团队/负责人索引；created_by_user_id 永不转名 |
| wb_task_transition | reassigned 的结构化原/新执行人、原会话标识字段；其他类型为空，原历史不删除 |
| wb_workspace_request（新增） | workspace/actor/request_id 唯一键、action、target_user_id、fingerprint、已确认的交接选择与变更摘要、response、created_at；作为本卡幂等回执和最小角色/交接记录，不扩展 HC-249 通用审计系统 |

旧仓库没有可信负责人，首次补充 owner 留空，不能把登记者自动当成负责人；管理员可在设置中逐项指定。HC-243 以后直接消费这一字段作当前负责人，见第 9 节。

现行 [Java 中继调整方案](../project/Java中继调整方案.md) D7/B4 明确未发版阶段维护单份 DDL、由运维执行，应用不做结构迁移。干净开发库按新版 DDL 初始化。需要保留已有团队/贡献的数据环境，由运维依照本节字段清单在维护窗口补结构，再执行带逐团队显式映射、预检/事务/结果清单的角色数据初始化；实施交付操作说明和受控数据初始化入口，禁止脚本隐式删库、自动推断管理员或直接连接目标库执行。启动须核对新列、合法状态及每团队至少一位有效管理员，未就绪给出缺项诊断。

## 9. 与其他卡的接点和并行边界

| 卡/接点 | HC-240 本期交付 | 后续联调 |
| --- | --- | --- |
| HC-241 知识审核 | 最新 WorkspaceRole、服务端 requireAdmin、当前直接发布写路径的管理权限、角色刷新；历史版本不变 | 提议、批准/退回、规约分级由 241 实现并在事务内复核 admin；240 不构造不存在的审核入口 |
| HC-243 系统地图 | 在既有团队仓库上建立唯一的当前 ownerUserId 和移除交接；不建地图表/第二套负责人 | 地图仍是知识类型，负责人展示解析 repositoryId 的当前负责人；历史地图版本保留当时内容。地图提议不能绕过管理员的负责人管理操作；两卡联调负责人变化展示，不重写已发布版本 |
| HC-239 个人会话 | active/removed 权限快照、成员撤销通知、共享停止及权限刷新接点 | 个人会话保留、已绑定团队不自动改绑；不改发布策略与本机执行权。共享 Session 类型/桌面顶层装配修改需统筹串行协调 |
| HC-233 记忆与知识工具 | 新身份刷新结果、当前团队失效通知及已有知识缓存失效调用 | 复核下一轮装配、工具调用和终态写回对移出团队的响应；不修改记忆合并/预算算法，不等待 239 整卡 |
| HC-219/220 Task/看板 | 交接后的新 assignee、reassigned 记录、离职 creator 的 owner 代管规则、既有 task.assigned/task.changed 刷新 | 必要的 Task UI/看板消费同步迁移；转交只产生待办，不触发他人的 Agent |
| HC-249 审计 | 角色/交接的最小不可混淆记录 | 以后通过统一审计模型消费本卡事实，不提前扩展共享出口扫描 |

共享文件（Schema、客户端身份状态、desktop-workbench 装配、workbench-context 权限接点）由统筹确认顺序后修改。实施前复查 HC-239 并行差异，只接权限/刷新接点，不代写其会话业务。接口定义先交付即可推进各卡独立部分，不以等待其他整卡作为角色基础的阻塞理由。

## 10. 可演示停点与必要冒烟

此处定义用户结果和最少证据。统筹已审查通过并派发依序补齐 Plan → Todo，再连续推进 A～D；阶段简短报告进展，整段交付或真实阻塞回调，不反复索要常规步骤确认。

| 停点 | 可观察结果 | 必要冒烟 |
| --- | --- | --- |
| A 角色与权限基础 | 真实服务返回 admin/developer；两种账号打开原桌面，管理能力不同 | 干净隔离 MySQL 初始化一 admin/一 developer；管理员提升/降级成功；开发者直接调用成员/仓库/知识发布写接口被拒；最后管理员拒绝；两管理员并发撤权后仍有一名有效 admin；已有知识固定版本未变 |
| B 成员交接服务 | 真实预览列全责任，提交后新负责人立即有待办；旧人失去团队读写权 | 构造 Task todo/doing/review、Project owner、仓库 owner 与历史会话；先预览后改 Task，旧提交 409 且零部分写入；有效提交完成交接/待认领及历史保留；跨团队/未确认 Project 接手人拒绝；requestId 重试不重复转交；离职 creator 的 Task 能由有效 Project owner 验收 |
| C 正式团队设置 UI | 原设置入口内可添加、改角色、预览并移除交接 | Electron 正常入口打开；两账号各自登录，管理员完整走角色变更和一次交接；被降级者已打开页面失去发布/管理能力；被移除者旧页/旧工具不可再拉团队资料；留任成员仍能主动读原共享历史并看到离开标记；接手人新会话不会接管旧 Agent |
| D 文档与收口 | 用户文档说明角色/离开/历史保留，任务标待验收 | 按实际生产变更运行必要类型、边界、构建、契约及 Java 构建；同路径验证不重复扩大；更新 Task/Todo 证据和架构增量，回调统筹，不自动归档/提交/推送 |

每段只验证新增核心路径，沿用未改部分证据。不运行旧全库测试，不使用真实模型 Key；本卡不需服务端模型调用。目标 TDSQL、完整中间件、双平台与完整回归由 HC-204 统一验收，隔离 MySQL/本机 Electron 通过不能冒充这些结果。

## 11. 统筹审查结论

2026-11-23 统筹已批准以下必要细化：历史团队显式指定管理员而不猜创建者；当前知识直接发布先收为 admin；仓库负责人复用现有 Repository 并允许待认领；Task 转交回到 todo 且保留旧会话来源；creator 离职后的验收由有效 Project owner 代管；交接时新增 Project 阅读权必须逐项确认。它们用于落实现有 Task 的权限与交接闭环，没有引入所有者、独立地图或远程执行。

按同名 Plan → Todo 实施，最终交付状态和已验证产品能力以 Task 中的真实证据为准。
