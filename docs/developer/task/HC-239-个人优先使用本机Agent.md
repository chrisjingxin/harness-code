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
scope: 登录后不依赖 Workspace 与 Project 即可使用本机 Agent，提供可用 ACP Agent 连通性预检引导；左栏顶部分“个人 | 团队”双轨：个人栏位统一展示全部个人会话并按工程目录折叠分组（不设团队/无团队筛选），团队栏位按 Workspace 切换团队并按 Project 折叠分组；个人会话只在本机保存、不上传；本机执行授权只核对当前账号、本机会话绑定与目录授权，与 Project 上传授权分离；个人会话可主动“发布到 Project”（汇总当前账号已加入团队的活跃 Project，选择项目并确认后共享全部已有已完成历史及后续定稿）、Project 会话可“停止共享”（保留已上传只读并标注“已停止同步”）；支持右键菜单与居中弹窗重命名会话；无团队会话在发布并确认后显式绑定目标 Workspace，团队知识/记忆装配边界由 HC-233 承接。
acceptance: 未加入任何团队的账号登录后能完成本机 Agent 预检并选目录完成一轮对话；服务端不可用时已登录用户仍能新建并继续个人会话；「个人」栏位展示账号全部未共享与已停止同步的个人会话并按工程目录分组，「团队」栏位支持切换 Workspace 并按 Project 分组；支持会话右键菜单与居中弹窗重命名；个人会话不出现在任何 Project 简报或成员视图；从个人会话发布到 Project 时只选目标项目并确认，固定完整正文与全部已有已完成历史，保留大小限制提示，后续定稿继续共享；停止共享后已上传内容保留只读并标注“已停止同步”，不再上传新内容、会话回到「个人」栏位继续本机使用。
user_docs: 实施阶段更新 docs/user/独立桌面工作台.md
developer_docs: docs/developer/architecture/个人与团队协同用户旅程.md；docs/developer/spec/HC-239-个人优先使用本机Agent.md；docs/developer/plan/HC-239-个人优先使用本机Agent.md；docs/developer/todo/HC-239-个人优先使用本机Agent.md
test_evidence: "2026-11-27 统一发布跟进：desktop typecheck/build 与核心历史检查 2/2 通过；新规则真实组件 CUA 假数据复核通过，正式服务上传未测。历史：停点1-4代码、E2E交互重构与缺陷修复（右键菜单与弹窗重命名/个人空间按目录全量展示/团队空间按Project组织/已定稿摘要同步）、docs/user/独立桌面工作台.md 与全栈自动化验证已通过（build、typecheck、check:boundaries -- --self-check、contracts:smoke、project:check、acp-runtime 30/30、collaboration-client 7/7、desktop 142/142、server mvn test 79/79）；远程验收环境需同步部署HC-239新版server及wb_conversation表结构（旧版服务缺shareMode/shareStatus/stoppedAt并拒收conversationId等新字段）"
references: docs/developer/architecture/多人协作工作台顶层设计.md；docs/developer/task/HC-218-会话只读与主动同步.md；docs/developer/task/HC-233-项目记忆与团队知识读取.md；docs/developer/task/HC-202-桌面工作台视图迁移.md；docs/developer/task/HC-249-共享出口脱敏与组织审计日志.md
completed_at: -
---

# HC-239 个人优先使用本机Agent

## 当前阶段

2026-11-27 最新用户确认：发布就是向项目成员共享已有对话，收敛为选项目并确认，固定完整正文及全部已有已完成历史，并共享后续定稿；不再提供两档、历史开关、起始轮次和额外确认勾选。此次是已有 HC-239 的桌面小范围跟进，取代下文历史发布选项，不重开原全栈验收。

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
     → 需要协作时：右键菜单或头部「发布到 Project…」→ 选活跃 Project 并确认（全部已有已完成历史及后续定稿）→ 自动切到「团队」空间并停留在当前会话
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
6. **统一发布范围（2026-11-27 修订）**：选择目标项目并确认，即共享全部已有已完成历史和后续定稿；提交固定 `full` 与 `historyFromTurnIndex: 0`。去掉共享档位、带历史开关、起始轮次、摘要编辑及额外确认勾选。正文由成员主动同步且只读，大小限制如实提示；已有摘要记录不自动转换。
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
- 2026-11-27 已核对现有 `markPublished → 历史遍历 → uploads.enqueue` 可复用：从下标 0 遍历所有已完成轮次。本次只简化桌面发布入口与直接调用方，不新增后端、契约或数据库改造。

## 待定问题（已在 Spec 收口）

1. 发布到 Project 时是否允许带上发布前的历史：**已在 Spec 收口**——2026-11-27 用户确认统一共享已有已完成历史与后续定稿，弹窗只选项目并确认（复用原 `conversationId`）；且个人会话（含无团队会话）均可主动发布到团队活跃 Project（无团队会话随发布显式绑定目标 Workspace）。
2. 个人会话本机存储方式与上限：**已在 Spec 收口**——采用独立本机存储 `LocalConversationStore`（`<userData>/workbench/local-conversations/<originSha256>/<accountId>/`），单会话上限 4 MiB 自动折叠旧轮、单账号上限 500 条。
3. （原“停止共享后是否保留”已收口：默认保留只读并标注“已停止同步”；原“公司对个人会话是否有审计要求”由 HC-249 承接“个人会话正文不进组织审计，共享出口脱敏与元数据审计”；原“仅共享状态档位”由 2026-11-27 统一发布规则取代。）


2026-11-24 衔接记录：本卡既有交付范围、作者与待验收状态保留。此前contextAssembler扩展槽的普通每轮实际blocks与稳定上下文键收尾，由用户本轮授权233/241整合方实施，见两卡最新Spec/Plan/Todo；不重开本卡。

## 2026-11-27 发布弹窗确认与错误可见性修复（旧规则历史证据）

本节保留当时修复与 CUA 结果；额外确认勾选、两档及可选历史已被本页后续“统一发布范围”规则取代。

用户反馈：勾选“一并带入发布前历史”后点击“确认发布”看似无反应。源码核对发现该选项与必填的共享范围确认是独立状态；未勾共享确认时 submit 仅设置错误并返回，确认项和错误原本都在 `.dlg-body` 末尾。全局正文限制 56vh 且可滚动、弹窗裁剪溢出，使确认/错误可能落在可见区下方，而按钮仍可点。

按已确认缺陷走快速路径，不新建任务或长设计：生产改动仅 `publish-conversation-dialog.tsx` 与 `personal-sessions.css` 两个桌面文件。将必填确认和提交反馈移到按钮上方的独立操作区域；发布弹窗专属样式按视口约束总高度，仅正文收缩滚动，短窗口使用紧凑间距，长标题省略且错误可换行。全局 `.dlg`/`.dlg-body` 与其它弹窗不改。

显式共享确认校验、历史默认不勾、历史范围、共享档位和原 onPublish 调用/参数保持原行为；未增加自动上传，未修改服务端或 ACP，也未替用户发布数据。同步用户说明，卡状态和原作者保留待验收。

受控入口位于 `/private/tmp/hc239-publish-preview-qwwpi1zl`，原 URL `http://127.0.0.1:5187/`，导入当前真实组件与现有主题/CSS，项目与历史均为虚构，本机 fake onPublish 显示受理次数和实参。统筹已使用 native Chrome＋cua_repl 完成以下必要组件冒烟；没有连接真实服务或运行 CDP/Playwright，临时入口不纳入仓库。验证结束后已停止本机 Vite session 91890（Ctrl-C，退出130）。

必要检查：`npm --workspace @workbench/desktop run typecheck`、`npm --workspace @workbench/desktop run build`、`npm run docs:check`、`npm run tasks:check`、`git diff --check` 均退出 0。源码 diff 仅两个前端文件，未重跑未受影响 MCP/存储或全库回归；CodeGraph 命令/工具不可用，OpenWiki 沿用已知缺失边界，不手改生成页。受控界面结果与正式服务发布验收分开记录。

统筹回传的 CUA 组件证据（2026-11-27）：未勾共享确认时点击“确认发布”，无障碍树实际出现“请先勾选不可收回共享范围确认。”；随后勾选带入历史和共享确认，fake onPublish 受理次数为 1，实际显示的输入 JSON 为 `shareMode: "full"`、`historyFromTurnIndex: 0`，弹窗关闭。开启 DevTools 形成短视口时，截图可见确认框与按钮保持在可见操作区，正文在内部受滚动限制。

验证边界：以上为真实组件＋现有主题/CSS＋fake organization/onPublish 的受控冒烟，不是正式服务器发布成功，历史上传未测；未做指定分辨率或窄屏全矩阵，后续重开未继续扩大。临时预览标签已由统筹通过 CUA 关闭，原 Chrome 标签恢复；统筹曾在真实 Electron 只读端切换个人/团队检查并恢复原会话，没有触发发布或重启 A/B。实现、必要代码检查与上述组件冒烟已完成，原任务保持待验收；无真实数据发布、无提交推送。


## 2026-11-27 统一发布范围跟进

用户确认：“我要发布，肯定是要把以前的对话带上呀，而且发布肯定是要给其他人看的，这里其实就只有一个选项，默认就是把之前的消息记录给项目成员共享。”按本次派发先同步 Spec → Plan → Todo，再实施桌面发布入口。

当前行为：选目标项目 → 点击“确认发布” → 固定提交 `shareMode: "full"`、`historyFromTurnIndex: 0`。弹窗移除档位、带历史开关、起始轮次、摘要编辑和额外不可收回勾选；范围说明保留“已有已完成对话与后续定稿、成员按需同步、已同步不可收回”。自动简报仍随登记发送，错误与按钮独立保持可见、正文可滚动，发布中禁用重复操作。旧选项的状态、校验、专属 CSS 及范围检查参数已删除，直接调用方不再有省略历史的分支。

上传路径核对：`usePersonalSessions.publishConversation → registerConversation → localConversations.markPublished → local-conversations-ipc` 从下标 0 遍历当前磁盘历史，仅将 `completed` 轮次依序交给 `ConversationUploads.enqueue`。`local-execution-coordinator` 对活跃共享的后续定稿仍使用已保存的 `full` 档位入队。成员正文仍按需同步、只读，轻量通知不推正文。服务端真实记录仍可能是 `summary_only`，其读取/停止共享调用仍在使用原模式，所以不删除服务端契约、共享上传器的真实档位门禁，也不新增兼容 wrapper 或自动改旧数据。

必要验证：

- `npm --workspace @workbench/desktop run typecheck`：退出 0。
- `npm --workspace @workbench/desktop run build`：退出 0，main / preload / renderer 均构建成功。
- `npm run docs:check`、`npm run tasks:check`、`git diff --check`：退出 0。CodeGraph 命令/工具不可用，按源码回退；`openwiki code --update --print` 实际退出 127（command not found），未手改生成页。
- `node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs --test --test-name-pattern '完整发布从第0轮|inspectPublishHistory' desktop/tests/local-conversations-ipc.test.ts desktop/tests/personal-sessions-model.test.ts`：2/2 通过、0 跳过。真实临时 `LocalConversationStore`、真实 IPC 注册器与真实待传账本串联：5 轮中全部 3 个完成轮均被交付，取消/失败轮被排除；其中超限轮被真实上传器拒绝并报告 32 KiB，另 2 轮以 `full` 的用户/助手消息落入待传文件。夹具未启用上传账号，网络端口设为调用即失败，不进行真实上传。

新版 CUA 复核（统筹回传，2026-11-27）：在 IAB 独立标签打开原预览地址 `http://127.0.0.1:5187/`，真实组件与现有主题/CSS 使用假项目、假历史及 fake onPublish，实际截图为 703×630。弹窗仅有目标项目、范围说明、轮次数、超限提示和取消/确认发布按钮，没有档位、带历史或额外确认勾选。直接点击“确认发布”后，按钮实际显示“正在发布…”并禁用；随后弹窗关闭，页面 fake onPublish 受理次数为 1，实际 JSON 为 `shareMode: "full"`、`historyFromTurnIndex: 0`。再次打开模拟失败并直接确认，错误“隔离回调模拟失败：请检查所选项目后重试。”位于按钮正上方，同一截图中错误和按钮均可见，未扩大短视口矩阵。这些是新规则的受控组件证据，与前节旧勾选流程证据分开，不等同正式服务器发布成功。

预览清理：入口文件仍位于 `/private/tmp/hc239-publish-preview-qwwpi1zl`，不纳入仓库；本次已将持有的 Vite session 85319 以 Ctrl-C 停止，工具返回退出码 130。统筹因 Chrome 正被用户使用而未继续操作其标签；本实施对话未进行浏览器或真实 A/B 操作。

验证边界：本次没有启动或重启 A/B、切换账号、发布用户真实会话或调用线上服务；正式服务器历史上传未测。已有大小限制保留，已跳过内容不承诺完整上传，本机早已折叠的旧原文也不会恢复。原作者与待验收状态保留，不调用 Skill、不提交推送；本次已完成统筹的新规则受控界面复核并回写证据，仅补 Task / Todo 和停止临时预览服务，没有重复运行已通过的构建或测试；按授权一次回调统筹后停止。
