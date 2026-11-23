---
id: HC-240
title: Workspace角色管理
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Devin
priority: P1
status: 待验收
owner: 用户（本机）
branch: harness_lody
scope: Workspace 设管理员与开发者两种角色；管理员管理成员与角色、登记团队仓库、审核知识与系统地图提议；开发者可使用、提议、创建 Project；创建者默认管理员，最后一名管理员不可降级或移除；支持成员移除或离职时一键转交其名下未完结 Task 与系统地图仓库负责人，已发布会话保留只读并标注“原成员已离开”；桌面提供成员、角色与交接管理界面并按角色显示可用操作。
acceptance: 管理员能把成员设为开发者或管理员，变更后对方立即获得或失去审核入口；开发者看不到成员管理与审核操作，直接调用对应接口被服务端拒绝；尝试降级或移除最后一名管理员时界面与接口都给出明确拒绝原因；已发布的知识版本不因审核人角色变化而改变；管理员移除成员时可一键转交其未完结 Task 与仓库负责人给其他有效成员，转交后新负责人即刻可见待办，该成员此前已发布到 Project 的会话保留只读并标注“原成员已离开”。
user_docs: 实施阶段更新 docs/user/独立桌面工作台.md
developer_docs: 同名 Spec、Plan、Todo；docs/developer/architecture/个人与团队协同用户旅程.md；docs/developer/project/团队角色初始化.md
test_evidence: 2026-11-23 类型/构建、Node与Java契约、边界和project检查通过；隔离MySQL/Java真实角色/交接和正式Electron UI及通知撤权冒烟通过；显式历史角色初始化/重复执行保留权限通过；完整回归与目标平台归HC-204
references: docs/developer/architecture/多人协作工作台顶层设计.md；docs/developer/task/HC-212-协作应用与看板通知.md；docs/developer/task/HC-243-团队系统地图.md
completed_at: -
---

# HC-240 Workspace角色管理

## 当前阶段

2026-11-20 用户确认 Workspace 要像 Git 仓库一样有角色管理，分管理员和开发者；知识与系统地图的审核人为管理员。2026-11-23 补齐企业团队人员异动诉求：纳入“成员移除/离职时的未完结任务与仓库负责人一键交接，以及历史共享产出保留只读”。本卡修订原顶层设计中“Workspace 不预设岗位角色”的规则。

2026-11-23 用户在统筹 lody 对话授权“继续吧，开发 240”。已登记用户（本机）/`harness_lody` 认领并同步看板，当前为 **A～D 本期全栈实现与必要验证已交付，待验收**。已核对真实契约、Java 权限/事务、数据库、客户端和桌面接点，形成[同名 Spec](../spec/HC-240-Workspace角色管理.md)。统筹已授权补齐 Plan、Todo 后连续推进角色、交接服务、正式设置 UI 与收口，不自动归档、提交或推送。

## 要解决的问题

- 当前契约中 Workspace 成员只有用户信息（`platform.schema.json` 的 `MemberSummary` 仅含 `user`），没有角色。知识审核（HC-241）、系统地图审核（HC-243）、成员管理都需要“谁有权”的依据。
- 成员转岗或离职被移出团队时，若直接切断关联，其名下未完结 Task、担任负责人的仓库和历史已共享会话容易成为“孤儿资产”，影响项目连续性。

## 角色与权限

| 能力 | 管理员 | 开发者 |
| --- | --- | --- |
| 使用本机 Agent、个人会话 | ✓ | ✓ |
| 读取团队知识、系统地图 | ✓ | ✓ |
| 提议新增 / 修改知识与系统地图 | ✓ | ✓ |
| 审核并发布知识与系统地图 | ✓ | — |
| 直接修改“规约”级知识 | ✓ | — |
| 管理成员与角色、移除交接、登记 Workspace 仓库 | ✓ | — |
| 创建 Project、发布会话、发布 Task | ✓ | ✓ |

## 已确认的范围

1. 两种角色：管理员、开发者。创建 Workspace 的人默认是管理员，允许多名管理员。
2. 最后一名管理员不能被降级或移除。
3. 角色变化立即生效；被降级的人失去审核入口，已发布内容不受影响。
4. Project 内现有 `owner/member`（`ProjectRole`）与 Workspace 角色相互独立。
5. **成员移除/离职交接**：移除成员 ≠ 删除团队产出。管理员发起移除成员前，界面展示该成员当前名下的未完结 Task 列表、Project 负责人身份与系统地图仓库负责人身份，支持指定新接手人一键批量转交（或标为待认领）；该成员历史已发布到 Project 的会话与知识贡献记录继续保留只读，作者显示旁标注“原成员已离开”。
6. 桌面在团队设置中提供成员列表、角色显示、修改与离职交接弹窗；按当前角色显示或隐藏管理、审核操作。权限与交接以服务端为准，前端不另造。

## 职责与前置

- 本卡全栈实施：服务端（`contracts/` + `server/` + `packages/collaboration-client/`）负责角色模型、成员交接与转交接口、权限校验和数据存储；桌面端负责团队设置中的成员列表、角色变更、离职交接弹窗及按角色控制管理/审核入口展示。
- 桌面侧界面在服务端能力交付前可先以受控预览完成。

## 已审查通过的方案

1. 首版只设管理员/开发者，不增加所有者；创建者作为历史事实记录，不成为第三种权限角色。
2. 现有团队无创建者字段，历史管理员按逐团队显式映射初始化，其余成员为开发者；未知创建者留空，不按 Project owner、加入时间或登记者自动提权。新演示团队显式以工号 80278667 初始化一名管理员，重复初始化不覆盖后续角色或移除结果。
3. 现有仓库没有负责人，在 Repository 上补唯一的当前负责人，允许待认领，HC-243 消费同一字段；不另建地图实体。
4. 交接未完结 Task 时回到待接收并保留旧会话来源；原 creator 保留，离职后的编辑/取消/验收由有效 Project owner 代管。新增 Project 接手人阅读权必须逐项确认。
5. 知识当前没有提议/审核接口，本卡先把已有直接发布写路径收为管理员权限；HC-241 负责提议审核，HC-243 复用该流程。以上方案已由统筹审查通过；实现结果另记真实证据。

## Spec 阶段工具记录（历史）

- 文档与任务检查：`npm run docs:check`、`npm run tasks:check`、`git diff --check` 通过。Spec 初稿阶段仅变更规格与认领材料；后续生产实现和真实冒烟见 C/D 交付节。
- 当前无 CodeGraph MCP/CLI 及 `.codegraph/` 索引；回退 `rg`/源码读取。已读 `openwiki/quickstart.md`，执行 `openwiki code --update --print` 返回 `command not found: openwiki`，没有手改生成页。
- 已批准的可演示停点、必要冒烟、共享文件接点和 HC-241/243 联调边界见 Spec 第 9～11 节。

## A/B 实施进度（2026-11-23）

角色/成员、管理员写权限、团队先行锁、显式初始化及事务交接服务已实现。隔离 MySQL/Java 冒烟通过（`scripts/workbench/run-workspace-roles-smoke.sh`），证据 `/private/tmp/hc240-live.7rF5n3/api-evidence.json`：包括并发最后管理员、过期预览零部分写入、Project 新增阅读权显式确认、幂等、Task 执行人与原 creator 分离、离职验收代管、只读历史和仓库待认领。正式 Electron 验证已接续完成，见下文证据。


## C/D 交付与 Review（2026-11-23）

- 已补齐并兑现同名 [Spec](../spec/HC-240-Workspace角色管理.md)、[Plan](../plan/HC-240-Workspace角色管理.md)、[Todo](../todo/HC-240-Workspace角色管理.md)。服务端实际校验 admin，最后管理员保护和交接使用团队先行锁；Workspace 角色没有替代 Project owner/member。
- 正式设置页已消费真实接口：成员添加/角色、仓库登记和负责人、完整预览、逐项 Project 阅读权确认、移除。Task 回到待接收，原 creator、固定引用和旧会话来源保留；离职验收职责由有效 Project owner 承接。历史云端会话停止上传且可供留任的有权成员只读。
- 主进程通过真实身份刷新、团队修订号和现有轻量 SSE 收回旧页面权限；原知识/记忆工具消费当前资格与已有缓存失效接点。没有修改 ACP 正文发送、轮次 ID、233 记忆合并、239 发布业务或新增 241/243 的假入口。
- 已复核 diff 的职责归属、封闭请求/响应、最后管理员、完整责任摘要、接手人 Project 边界、原作者不转名、事务回滚/回执和迟到响应保护；发现历史初始化混合数据与未知团队应拒绝、添加回执应保存稳定 userId，已修正并完成必要构建核验。未遗留已知本卡正式主路径阻塞。
- 用户说明更新于 [独立桌面工作台](../../user/独立桌面工作台.md#团队角色与成员交接)，架构增量见 [用户旅程第 3.1 节](../architecture/个人与团队协同用户旅程.md#31-hc-240-权限与交接增量2026-11-23)，运维入口见 [团队角色初始化](../project/团队角色初始化.md)。未升版，未提交、推送或归档。

### 验证命令与结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck`；`npm run build` | 四个工作区通过；后续仅桌面改动的类型/构建也通过 |
| `npm run contracts:smoke`；`java -jar server/target/collaboration-server-0.2.0.jar --workbench.command=contracts` | Node/Java 同源夹具通过，含新角色正反例 |
| Maven 3.9.11 / JDK 21：`mvn -B -o -f server/pom.xml -Drevision=0.2.0 -Dmaven.repo.local=<临时缓存> -DskipTests package` | 生产与既有测试源码编译、jar 打包通过；未运行 Java 全套单测。旧测试调用方已直接迁移新类型，无兼容构造器 |
| `npm run check:boundaries -- --self-check`；`npm run project:check`；`git diff --check` | 通过，包含桌面子层/退役目录负例；Task 看板同步 |
| `bash scripts/workbench/run-workspace-roles-smoke.sh`（显式 JDK/MySQL 环境） | 真实 API：角色变更、开发者拒绝、最后管理员/并发保护、过期预览零部分写入、显式 Project 加权、幂等移除、Task creator 保留与验收代管、只读历史及仓库待认领通过 |
| `node scripts/workbench/smoke-workspace-desktop.mjs <隔离origin> <证据目录>` | 已构建正式 Electron，真实管理员/开发者登录、角色变更、界面交接、新负责人任务、离开标记、已打开页面随真实 SSE 获得/失去权限、旧窗口发布被服务端拒绝均通过 |
| 一次性 `init-workspace-roles` 隔离数据核验 | 缺少映射失败且未提权；显式初始化成功；真实角色修改并移出后重复初始化仍保留原角色/removed/版本；未知创建者留空 |

本机证据目录：`/private/tmp/hc240-live.7rF5n3/`，包含 `api-evidence.json`、`desktop-evidence.json`、`desktop-handoff.png`、`bootstrap-evidence.tsv` 与初始化日志。构建/类型/契约/边界日志为 `/private/tmp/hc240-*.log`。UI 冒烟早期曾修正登录加载时机、同名背景按钮选择和响应层级读取的脚本问题，最终正式主路径 PASS；没有用夹具或网络替身掩盖失败。

### 尚未宣称通过的范围

- 目标 TDSQL、完整 Redis/Kafka/ES、中间件恢复、Windows/macOS 完整矩阵及全库回归由 HC-204 统一验收；本次为隔离 MySQL 8.4 / standalone Java / macOS 正式 Electron。
- HC-241 提议/审核与 HC-243 地图展示尚无正式能力，后续分别复用本卡角色策略与唯一 Repository owner，不把这些后续卡标成已实现。
- HC-233 真实 Agent 工具的完整中途撤权组合、HC-239 所有个人发布/停止共享组合沿各卡与 HC-204 联调；本卡已消费原有权限/缓存接口，未因此改其业务算法。没有调用模型或转移他人执行权。
