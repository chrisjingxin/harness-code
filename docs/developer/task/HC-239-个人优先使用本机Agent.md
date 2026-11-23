---
id: HC-239
title: 个人优先使用本机Agent
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Devin
priority: P0
status: 待验收
owner: Antigravity
branch: harness_lody
scope: 登录后不依赖 Workspace 与 Project 即可使用本机 Agent，提供可用 ACP Agent 连通性预检引导；左栏顶部分“个人 | 团队”双轨：个人栏位统一展示全部个人会话并按工程目录折叠分组（不设团队/无团队筛选），团队栏位按 Workspace 切换团队并按 Project 折叠分组；个人会话只在本机保存、不上传；本机执行授权只核对当前账号、本机会话绑定与目录授权，与 Project 上传授权分离；个人会话可主动“发布到 Project”（汇总当前账号已加入团队的活跃 Project，支持“完整定稿正文”或“仅共享状态与成果摘要”两档）、Project 会话可“停止共享”（保留已上传只读并标注“已停止同步”）；支持右键菜单与居中弹窗重命名会话；无团队会话在发布并确认后显式绑定目标 Workspace，团队知识/记忆装配边界由 HC-233 承接。
acceptance: 未加入任何团队的账号登录后能完成本机 Agent 预检并选目录完成一轮对话；服务端不可用时已登录用户仍能新建并继续个人会话；「个人」栏位展示账号全部未共享与已停止同步的个人会话并按工程目录分组，「团队」栏位支持切换 Workspace 并按 Project 分组；支持会话右键菜单与居中弹窗重命名；个人会话不出现在任何 Project 简报或成员视图；从个人会话发布到 Project 时可选“仅共享状态与成果摘要”（成员可见进展与结论摘要但看不到完整试错过程）或完整正文；停止共享后已上传内容保留只读并标注“已停止同步”，不再上传新内容、会话回到「个人」栏位继续本机使用。
user_docs: 实施阶段更新 docs/user/独立桌面工作台.md
developer_docs: docs/developer/architecture/个人与团队协同用户旅程.md；docs/developer/spec/HC-239-个人优先使用本机Agent.md；docs/developer/plan/HC-239-个人优先使用本机Agent.md；docs/developer/todo/HC-239-个人优先使用本机Agent.md
test_evidence: "停点1-4代码、E2E交互重构与缺陷修复（右键菜单与弹窗重命名/个人空间按目录全量展示/团队空间按Project组织/已定稿摘要同步）、docs/user/独立桌面工作台.md 与全栈自动化验证已通过（build、typecheck、check:boundaries -- --self-check、contracts:smoke、project:check、acp-runtime 30/30、collaboration-client 7/7、desktop 142/142、server mvn test 79/79）；远程验收环境需同步部署HC-239新版server及wb_conversation表结构（旧版服务缺shareMode/shareStatus/stoppedAt并拒收conversationId等新字段）"
references: docs/developer/architecture/多人协作工作台顶层设计.md；docs/developer/task/HC-218-会话只读与主动同步.md；docs/developer/task/HC-233-项目记忆与团队知识读取.md；docs/developer/task/HC-202-桌面工作台视图迁移.md；docs/developer/task/HC-249-共享出口脱敏与组织审计日志.md
completed_at: -
---

# HC-239 个人优先使用本机Agent

## 当前阶段

2026-11-20 用户确认：登录后即可使用本机 Agent，进入 Project 后才有会话共享等协作能力；个人会话使用当前选中团队的知识。2026-11-23 补齐个人与团队双轨细节：纳入左栏多团队切换 UI、本机 Agent 连通性预检引导、“仅共享状态与成果摘要”档位及停止共享只读策略，并完成全栈实施口径确认。已于 `harness_lody` 认领并产出 [HC-239 Spec](../spec/HC-239-个人优先使用本机Agent.md)、[HC-239 Plan](../plan/HC-239-个人优先使用本机Agent.md) 与 [HC-239 Todo](../todo/HC-239-个人优先使用本机Agent.md)（已按用户要求对齐[方案 B 交互原型](../previews/personal-team-workbench/README.md)与个人会话共享到团队 Project 规则）。整体旅程见[个人与团队协同用户旅程](../architecture/个人与团队协同用户旅程.md)第 4 节及第 7 节旅程 0、1、8。2026-11-23 停点 1–4 实施、根据试测反馈完成的左栏交互（Codex 风格右键菜单与居中弹窗重命名、个人栏位全量按工程目录分组、团队栏位按 Project 组织）及默认摘要实时落盘修复、用户文档更新与全栈自动化验证均已完成，本卡状态保持 `待验收`（注：远程验收服务端需升级到包含 `wb_conversation` 新列及新版 DTO 的 `server/` 后方可联调发布与列表接口）。

## 要解决的问题

现在只有“已登录 + 已选团队 + 已进入 Project”才能使用 Agent：

- 桌面入口在未选 Workspace 时只显示“当前账号未加入团队”，无法开始任何会话（`desktop/src/renderer/desktop-workbench.tsx`）。
- 本机执行每次都先向服务端确认会话属于某个 Project（`desktop/src/main/local-execution-coordinator.ts` 的 `authorize()` 调用 `getProjectConversation`），服务端或网络不可用时本机 Agent 也不可用。
- 所有试验性对话都会成为 Project 会话，制造噪音并带来隐私顾虑；同时已有设计把多团队切换留待后续，导致跨团队人员无法流畅切换团队上下文，开发者也不愿把冗长试错过程全部暴露到 Project。

设计文档早已写明“不属于 Project 的个人会话保持私有”，本卡让实现与设计一致。

## 预期使用过程

```text
登录 → 首次可用性引导（检测本机 ACP Agent 与模型连通性）
     → 左栏「个人」空间按本机目录分组 → 选目录与 Agent → 对话（只存本机，支持右键/弹窗重命名）
     → 需要协作时：右键菜单或头部「发布到 Project…」→ 选活跃 Project 与共享档位（完整定稿正文 / 仅共享状态与成果摘要）→ 自动切到「团队」空间并停留在当前会话
     → 不再共享时：「停止共享」→ 保留已上传内容为只读并标注“已停止同步”，回到「个人」空间不再上传新内容
左栏「团队」空间支持切换当前 Workspace，并按 Project 折叠分组浏览本人与队友协作会话
在某个 Project 内新建会话 → 默认发布到该 Project，头部明确显示“Project 可见”
```

## 已确认的范围

1. **去掉使用前置与冷启动预检**：已登录即可进入工作台；未加入团队时团队区域显示空态说明，Agent 照常可用。登录仍是必需的。首次进入或新建会话无可用 Agent 时，提供本机 ACP Agent 与网关/模型连通性预检引导。
2. **个人会话本机保存**：个人会话的历史、草稿、目录绑定在本机按账号隔离保存，不上传、不生成云端简报。
3. **授权分离**：本机执行只核对当前账号、本机会话绑定与用户授权目录；Project 会话的定稿上传仍按现有用户 Cookie/CSRF 与成员身份授权。服务端不可用时执行照常，上传排队补传（沿用现有“本机记录执行事实和待上传内容”）。
4. **一套会话模型**：个人会话与 Project 会话是同一种会话，Project 归属可选；上传是挂在会话上的发布器，不新增第二条执行链路。
5. **发布与停止共享**：发布是主动动作并确认范围（配合 HC-249 做发布前本机敏感信息扫描）；停止共享后不再上传，已上传内容默认保留在 Project 中作为只读记录并显著标注“已停止同步”，避免打断他人既有引用快照。两者都如实说明“已被他人同步的内容无法收回”。
6. **“仅共享状态与成果摘要”档位**：个人会话发布到 Project 时，除“完整定稿正文”外，支持选择“仅共享状态与成果摘要”，仅将阶段进展、最终结论摘要与关联仓库/PR 信息同步至 Project，不上传详细试错过程消息；成员在看板或只读页看到摘要与结论，可进一步发起交流或请求分享。
7. **默认归属看入口**：「个人」空间中新建为个人会话；Project 内新建默认发布到该 Project（保留现有“Project 内默认共享”）。
8. **团队上下文与可见性分开**：未发布个人会话保持本机私有（个人界面不暴露团队选择器）；仅当主动「发布到 Project…」并确认后显式绑定目标 Workspace，下一次发送开始使用该团队知识与本机记忆（停止共享后保留团队绑定）。具体团队知识与本机记忆取材边界由 HC-233 交付。
9. **左栏双轨组织与重命名交互（2026-11-23 修订确认）**：「个人」空间展示账号全部未共享与已停止共享的个人会话，统一按**本机工程目录**折叠分组，不设团队/无团队筛选；「团队」空间支持在同一桌面壳内切换 Workspace 并按 **Project** 折叠分组组织协作会话。会话重命名采用 Codex 风格右键菜单与居中弹窗。
10. **离开团队**：已发布到该团队的会话在本地自动收敛为停止同步，已保留在本地的个人会话仍可读与继续执行，但不再注入该团队的知识与本机记忆。

## 不在本卡范围

- 团队知识目录、读取工具和本机 `team.md` / `personal.md`：HC-233。
- 多目录会话：HC-242。
- Workspace 角色：HC-240。
- 发布前敏感信息扫描与组织审计日志：HC-249。
- 同账号多设备、跨机器续接个人会话。

## 职责与前置

- 桌面负责入口与导航（含多团队切换 UI 与预检引导）、个人会话本机存储、授权分离与发布/停止共享界面，需与 HC-218 的正式桌面桥接对齐。
- HC-233 与本卡都会修改 `desktop/src/main/local-execution-coordinator.ts`：本卡要把执行范围中的 `projectId` 改为可选并加入会话团队上下文，HC-233 要在同一位置装配知识与记忆。两卡在 Spec 阶段先约定执行范围接口，再并行实施。
- 只同步“发布之后”的内容不需要新增服务端能力。若决定发布时带上已有历史，需要服务端历史补传能力；若“仅共享状态与成果摘要”需在会话头与同步接口区分可见模式字段，以上能力按全栈分工同步在 `contracts/`、`server/` 与 `packages/collaboration-client/` 中补齐。

## 待定问题（已在 Spec 收口）

1. 发布到 Project 时是否允许带上发布前的历史：**已在 Spec 收口**——默认仅同步发布后的新轮次，发布弹窗支持勾选带入已定稿历史（复用原 `conversationId`）；且个人会话（含无团队会话）均可主动发布到团队活跃 Project（无团队会话随发布显式绑定目标 Workspace）。
2. 个人会话本机存储方式与上限：**已在 Spec 收口**——采用独立本机存储 `LocalConversationStore`（`<userData>/workbench/local-conversations/<originSha256>/<accountId>/`），单会话上限 4 MiB 自动折叠旧轮、单账号上限 500 条。
3. （原“停止共享后是否保留”已收口：默认保留只读并标注“已停止同步”；原“公司对个人会话是否有审计要求”由 HC-249 承接“个人会话正文不进组织审计，共享出口脱敏与元数据审计”；原“仅共享状态档位”已纳入本卡第 6 条。）
