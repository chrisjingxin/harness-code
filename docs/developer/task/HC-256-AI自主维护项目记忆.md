---
id: HC-256
title: AI自主维护项目记忆
feature_area: 独立桌面协作工作台
parent_task: HC-233
decomposed_by: Codex
priority: P1
status: 待验收
owner: 用户（本机）
branch: harness_lody
scope: 将本机 team.md、personal.md 改为当前 Agent 自主维护的普通 Markdown，通过桌面 MCP 整文读取及带内容版本的即时原子保存；迁移旧结构化记忆并保留原件，管理台保留查看编辑，引用预览按用户修订移除记忆展示；保留身份隔离、现有首轮全量后续变更增量和团队知识链路。本期交付待验收，未自动归档。
acceptance: Agent 可将用户新增或纠正的工程信息即时写入两份 MD，saved 后取消或失败不回滚；冲突与可恢复失败作为普通工具结果返回且会话可继续；超过8KiB仅提示整理；旧数据有原件备份且损坏文件不覆盖；管理台可查看编辑两份 MD，引用弹窗不显示本人项目记忆且保留原引用流程；账号、Team、会话及实际目录授权边界保持有效。
user_docs: docs/user/独立桌面工作台.md
developer_docs: docs/developer/spec/HC-256-AI自主维护项目记忆.md；docs/developer/plan/HC-256-AI自主维护项目记忆.md；docs/developer/todo/HC-256-AI自主维护项目记忆.md；docs/developer/architecture/项目记忆与团队知识上下文.md
test_evidence: 2026-11-26引用预览入口修订的desktop类型/构建、docs:check、tasks:check、diff检查通过；初版MCP/ACP/协调器/存储及统筹CUA组件证据保留，不重跑未受影响链路；此次未操作真实UI或A/B
references: docs/developer/task/HC-233-项目记忆与团队知识读取.md；docs/developer/task/HC-239-个人优先使用本机Agent.md；docs/developer/task/HC-241-知识分级与审核沉淀.md
completed_at: -
---

# HC-256 AI自主维护项目记忆

> **2026-11-26 用户交互修订：** 用户在引用他人会话的预览中看到本人 team.md/personal.md，确认不应在此展示。当前仅「管理与设置 → 本机项目记忆」提供手动查看编辑；初版两入口交付和验证记录保留历史，由本修订替代当前入口要求。两份 MD 的内容、自动注入和 MCP 能力不变。

## 当前阶段与授权

2026-11-26，用户批准“这个任务改动留痕，可以新建任务卡，然后修改”。用户（本机）在现有 `harness_lody` 工作区承接本卡，父任务为 HC-233。文档阶段先交付 Task → Spec → Plan → Todo 和看板并回调审查。随后统筹确认设计通过，将普通 MD、MCP/上下文与两处轻量 UI 合为本轮完整交付，原三个实施停点改作内部顺序；现已完成，标待验收。

本卡不调用 Skill、不派生代理、不提交推送、不切换分支或另建工作区。保留共享未提交内容。验证沿用必要冒烟节奏，完整回归由 HC-204 统一处理。本轮不操作真实 A/B 实例、不重启服务、不读取或迁移真实用户记忆文件。

## 痛点与用户收益

目前 AI 更新记忆必须填入条目、来源和目录事实证明。用户在对话里确认目录后，确认信息不一定能变成宿主要求的 `confirmedDirectory`；模型可能反复确认，或者改用旧来源继续提交，最终工具异常使整轮失败。用户希望当前 Agent 像维护普通说明文档一样理解、纠正和整理记忆，宿主专注保护文件、身份和并发写入。

已提供的故障线索：原生会话 `ee1d018f-8cf0-475c-b841-46d3e9a5dec8`，运行 `f2794b7e-930e-4eb8-a3e5-db3a747745a3`；三次提案返回 `needs_confirmation`，问答确认未进入目录证明，之后来源校验抛出工具异常。该线索用于锁定旧机制问题，不在文档中转录模型私有思考或真实文件内容。

改后流程：用户提供新信息或纠正 → 当前 Agent 读取最新 MD → 合并并整理 → MCP 比对内容版本并立即保存 → 工具卡显示实际结果。无新信息不写，歧义先问用户；已保存的结果不依赖之后的对话终态。

## 范围与边界

- 两份普通 Markdown 是当前内容的唯一事实源；删除业务条目 schema、强制 YAML、来源准入、目录事实证明与 Git 匹配门槛。
- 以 `read_project_memory(document)` 和 `update_project_memory(document, content, expectedRevision)` 替换旧两个记忆工具；沿既有桌面 HTTP MCP 与标准 ACP 配置提供给支持该 MCP 接入方式的 Agent。
- 保留服务 origin、账号、Team、登录代次、本人真实会话和原生绑定的隔离；保留本地原子写入、路径保护及现有目录执行授权。
- 保留现有首轮完整基线、后续仅发送发生变化文档的机制；每份发生变化的文档发送完整正文，不按当前 Project、cwd 或关键词过滤。
- 管理台使用轻量 Markdown 查看/编辑组件；引用预览不展示本人项目记忆，只保留原引用流程。旧条目端口已删除，复用现有主题、Markdown 和工具卡。
- 旧文件经过原件备份和原子迁移，损坏文件只读保护。迁移只在 tmp 隔离副本验证，真实用户迁移时机由统筹决定。
- 本机 `team.md` 仍是当前账号在该 Team 的本地记忆；团队共享知识的检索、固定版本、审核、贡献和读取回执沿现有路径，不新增服务端 API、schema、ACP 方法、第二模型或用户配置。

## 可观察的验收结果

| 编号 | 结果与证据 |
| --- | --- |
| A1 | 同一 Agent 通过 MCP 读到普通 Markdown 和 SHA-256 内容版本，无 entryId/sourceIds；新事实或用户纠正可以立即保存，不要求再次选择目录。 |
| A2 | update 返回 `saved` 后立刻从磁盘读到新正文；随后取消、运行失败或终态迟到均不回滚，下一次发送可见变更。 |
| A3 | 两个会话持同一旧版本写同一文档时，仅一个保存；另一个收到普通 `conflict`，重读合并后可继续。写入 team 与 personal 分别反馈，后一次失败不撤销前一次保存。 |
| A4 | 合计超过 8 KiB 的正文仍可保存并提示整理；超过现有 64 KiB MCP 请求技术限制时明确拒绝且原件不变；任何读取/注入均不静默截断。 |
| A5 | tmp 中的合法旧文件迁移前后保留业务正文和来源信息，原件备份逐字节一致；损坏、符号链接、越界路径不被覆盖；中断后重试不产生重复业务内容。 |
| A6 | 管理台显示当前 Team 的两份 MD，可分别预览、编辑、保存、遇冲突重读；引用预览不显示本人 MD，快照、范围、目标本人会话、草稿和新会话目录选择保持原行为。 |
| A7 | 首轮完整提供两份 MD，送达后相同内容不重复提供；改变其中一份时只发送该份完整正文；恢复/换绑定沿原有基线重建，知识读取和审核不受影响。 |
| A8 | 不同账号/Team 相互不可读写；退出、旧登录代次、无团队、他人会话及起草凭据不能修改记忆；记忆中的路径不会赋予文件访问权限或改变会话 cwd。 |

## 初版交付记录与后续（历史）

本期已交付普通 MD 存储及惰性迁移、即时 MCP 读写、既有增量上下文接线与两处轻量 UI，并更新用户文档和长期架构；没有操作真实用户文件或正在使用的 A/B 实例。具体协议和数据保护见 [Spec](../spec/HC-256-AI自主维护项目记忆.md)，模块及停点见 [Plan](../plan/HC-256-AI自主维护项目记忆.md)，逐项状态见 [Todo](../todo/HC-256-AI自主维护项目记忆.md)。本期标待验收，不自动归档、提交或推送。

2026-11-26 停点 0：`npm run tasks:sync`、`npm run docs:check`、`npm run tasks:check` 与 `git diff --check` 均退出 0。复核当前仅四份新文档、HC-233 Task/Spec 顶部说明、架构顶部说明及看板变化；工具/迁移/UI 仍为待审查设计。按统筹补充，后续 UI 检查由统筹使用 cua_repl 完成，不沿用旧 CDP 界面自动化；当前没有 UI 或运行态验证证据。

## 本期实施与证据（2026-11-26）

- `memory-store.ts` 直接持久化 MD，以 SHA-256 比对内容；`memory-files.ts` 保留短锁之外的安全文件操作，`legacy-memory.ts` 仅承接旧格式识别/校验和资料转换。两个新工具替换旧 query/propose，无 alias、双写或内容 JSON。
- `service.ts` 删除条目初始化、来源证明和提案终态写回，保留 DeliveredContext/pendingDelivery、规约及知识固定版本去重；工具调用内立即保存并反馈，后续取消/失败不回滚。
- shared/preload/IPC、管理台及引用预览接上同一 ProjectMemory 轻量组件；冲突保留草稿，可重读对照后手动合并；引用只使用本人候选目标会话，空作用域不伪造 UUID。真实 cwd、目录授权和 Agent 审批不变。旧运行工具、三条目端口和旧组件已删除，相关夹具已迁移。
- 产品在当前身份正常首次读取时逐份惰性迁移：严格识别旧四字段组合，合法原件先备份并核对字节，再保留正文和来源说明后原子替换。普通 front matter 不受旧 schema 限制；损坏文件保留。无需新配置或审批按钮，不扫描用户目录。

| 实际命令 | 结果与边界 |
| --- | --- |
| `npm run build --workspace @workbench/collaboration-client --workspace @workbench/acp-runtime --workspace @workbench/harness-acp` | 退出0；同步依赖构建产物，解决初次桌面类型检查读到旧 signedOut 类型的问题。未改该业务行为。 |
| `npm --workspace @workbench/desktop run typecheck` | 退出0。 |
| `npm --workspace @workbench/desktop run build` | 退出0，main/preload/renderer 已重建；未启动或重启运行实例。 |
| `npm run check:boundaries -- --self-check` | 退出0，4-workspace 依赖与退役路径负例通过。 |
| `node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs scripts/workbench/smoke-workbench-context.mjs` | PASS：tmp 旧文件原字节备份、损坏保护、普通 front matter、实际不存在目录的自由文字；真实回环HTTP MCP 即时保存、CAS冲突继续、超8KiB建议/超64KiB拒绝、两份独立；真实协调器/ACP 两轮增量、取消/失败保留已保存内容、固定知识读取去重。无模型网关或真实服务。 |
| `node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs --test desktop/tests/workbench-context-delta.test.ts` | 4/4 PASS：MCP instructions、零变化不注入/单边变化与规约增量、已读/force与未送达快照、协调器重置。 |
| `node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs scripts/workbench/smoke-context-binding.mjs` | PASS：真实协调器 prepare→ACP new/load→MCP，配置保留、凭据撤销/旧绑定保护及降级普通对话。 |
| `openwiki code --update --print` | 退出127：当前环境未安装 openwiki；未手改生成页，不作为本期主路径阻塞。 |

回环监听在默认 sandbox 中受限，最初增量测试清理时报 Server is not running；相同隔离命令经已授权权限运行后4项通过，没有放宽产品守卫。

统筹复用证据：`/private/tmp/hc256-ui-review-al6k88q1` 的当前真实组件＋主题/安全 Markdown＋mock host，经 cua_repl 完成 team读取→切personal→编辑→保存，实际显示保存结果与新正文。它是组件正常路径证据，不是正式 Electron/IPC 端到端，两处正式入口、UI冲突等没有逐项点击。未运行旧 CDP 界面脚本。

统筹独立 tmp 存储证据：自由 MD 包含未选择且不存在的路径仍 saved，立即磁盘字节一致，旧 revision 返回 conflict，不同账号与 Team 隔离均通过；样本已清理，无真实记忆数据。

Review：对照 Spec 和 diff 核对旧协议退出、成功落盘边界、独立结果、来源门槛删除、知识/送达状态保留及目标本人会话锚点，未发现需扩大范围的问题。外部编辑器与应用在最后检查到 rename 之间同时写入的窗口仍按 Spec 披露。完整矩阵、真实账号双机、Windows/TDSQL 与正式桌面 IPC 端到端留统筹/HC-204；不把 mock 证据写成真实业务验收。

使用新行为需运行已重建的新版本；当前已启动的 A/B 未重启，内存中的旧 main/preload 不会自动替换。用户下次自行重启并正常进入团队会话/记忆页，按当前身份读取时自动初始化或迁移指定文件；本轮没有手动迁移真实用户文件。

最终文档收口：`npm run tasks:sync`、`npm run docs:check`、`npm run tasks:check`、`git diff --check` 均通过。组件改名后同步修正 HC-255 Plan 的本地源码链接；其余旧过程正文保留历史。真实 Java/MySQL 的 smoke-context-turns 只迁移协议并做语法检查，本轮未连接真实服务重跑；两个旧 CDP 桌面脚本均未运行。

已向授权统筹 `01a18544-fba1-7952-b136-c72415113ebb`（local）回调实际改动、迁移规则、命令结果、未验证边界、重启要求及当前 worktree 文件列表。首次回调因自动审批服务用量限制未执行，用户继续后已补发成功。保持待验收并停止，不归档、不提交推送。

## 2026-11-26 用户交互修订：移除引用预览记忆入口

用户确认引用他人会话时不应展示本人两份项目记忆，统筹据此派发删除引用预览中的 ProjectMemory。基线为 `harness_lody@a5b8d0f8`，开工工作区干净。生产改动仅在 `conversation-references.tsx` 删除记忆专用导入、memoryScope 参数/透传及组件挂载；管理台入口保留。快照、取材范围、目标本人会话、草稿、新会话目录选择、自动上下文、MCP、存储/身份和真实目录授权均不改动。

此次沿用本卡留痕，更新当前 Spec/Plan/Todo、用户文档与架构说明；上文初版两入口交付/验证为历史，不作为当前引用预览的验收要求。只做 desktop typecheck/build、diff 和文档/任务检查，不新增镜像 JSX 测试、不重跑未受影响 MCP/存储全套，不操控或重启真实 A/B。CodeGraph/OpenWiki 缺失沿用已知限制，不手改生成页，不提交推送或切分支。

修订验证：`npm --workspace @workbench/desktop run typecheck`、`npm --workspace @workbench/desktop run build`、`npm run docs:check`、`npm run tasks:check`、`git diff --check` 均退出 0。复核源码 diff 仅删除引用预览记忆依赖与挂载，管理台 ProjectMemory 导入和挂载保留；全工作区仅 1 个生产源码与上述 6 个文档变化。已生成新构建，未操作界面或重启真实实例，不把源码核对写成 UI 实测。保持待验收。

此次修订已向授权统筹 `01a18544-fba1-7952-b136-c72415113ebb`（local）回调文件范围、检查结果与边界，按派发停止；未提交推送或归档。
