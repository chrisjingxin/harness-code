# 仓库协作规范

## 项目定位

本分支是独立桌面协作工作台，入口为 Electron + React/TypeScript。Harness/Python 是可选 Agent。2026-11-12 远端已合入 HC-210 Java 基础及 HC-211 四个服务端停点，HC-211 仍进行中，HC-212 待实施；桌面与 Runner 的新版业务装配尚需适配。实际阶段和验证以各 Task 为准。

根 npm workspace 只列新平台七个目录。`packages/cli`、`packages/protocol`、`packages/agent` 与 vendor 暂留作后续迁移来源，不进入新产品安装/启动/构建。产品入口说明以 README 和 docs/user 为准，过程文档放 docs/developer。

### HC-192 实施期间的用户覆盖规则

2026-11-12 最新分工：服务端与 ACP 的实现、相关设计文档均交同事维护，我方不修改或新增这些内容。当前仅推进桌面前端的信息架构、视觉、交互、组件和对已交付接口/宿主能力的消费；Runner 核心执行与同步内部设计也不由前端代写。接口缺口记录给同事，不新增后端 API、设备命令、线上 schema 或 ACP 方法。前端方案见 `docs/developer/architecture/桌面前端交互设计.md`，视觉预览源码保留在 `docs/developer/previews/project-collaboration/`。

2026-11-12 设计更新：Workspace 是团队，Project 是协作事项；会话绑定一个可非 Git 的本机 cwd，目录外访问按实际 Agent 能力和授权处理。跨机器会话均只读，包括同账号其他设备；正文主动拉取，本机上传定稿消息与工具摘要。用户已明确后端、轻量 SSE 和 ACP 以当前远端为准：沿用 HC-210/211/212、Java中继调整方案及当前契约/实现，不另建通知或协议方案。轻量 SSE 更新简报/Task 等元数据，不下载正文或触发执行；设备仅 HTTPS 上传和心跳，无下行通道。跨机器不读取实时文件/Git，Git 写入口暂缓，本机阅读组件保留。完整目标见 `docs/developer/architecture/多人协作工作台顶层设计.md`。

用户已授权登记前端任务并在本地 commit，最新指示是不推送远端：HC-217 项目导航与资料、HC-218 会话只读与主动同步、HC-219 引用任务与团队知识、HC-220 项目看板与轻量通知。四卡均待认领，本次不自动认领或开启生产实施；认领后按 Spec → Plan → Todo 推进。HC-195/196/198 已被远端标过时，引用、产品 Task、知识与看板的服务端仍由 HC-212 承接，不重复开后端卡。四卡职责、并行目录和串行共享接点见 `docs/developer/project/项目协作设计任务衔接.md`。HC-197 同事归属不变，已合入协议按实际公开能力消费，缺少的运行时入口记录真实前置，不重复分配 ACP 实现；本条覆盖历史等待记录中与实际交付不符的部分。

以下是用户当前明确要求，覆盖本文默认 Skill、TDD、逐停点确认和全库测试节奏：不调用 Skill；每个实施任务只做必要安装/构建/类型/边界/真实冒烟，全部开发后在 HC-204 统一测试；由统筹调度左侧可见实施对话，不派生隐藏代理；阶段完成或遇到真实阻塞时回调指定统筹，不轮询。Spec → Plan → Todo 顺序保留，统筹审查派发后实施；阶段通过只标待验收，不自动归档。

实施阶段的冒烟只确认正常入口能打开、改动的核心使用路径能走通。直接沿用未受影响的验证结果，窗口操作和证据记录以 [并行开发约定第 4 节](docs/developer/project/协作任务并行开发约定.md#4-上传云端后的认领与集成) 为准。

使用 harness_lody 当前工作区，保留已有未提交内容，不自动提交/推送、切分支、stash/reset/clean 或另建 worktree。新根锁正常同步 node_modules 获得授权，干净副本额外证明不依赖旧工具，不维护双安装链。

2026-11-06 补充：中央对话/头像/工具/输入及右侧文件/变更 UI 优先从现有 Web 迁出复用，仅替换旧状态/动作依赖；左侧工作区/设备/共享会话等新增区域另写，不整体重画中右区域。HC-205～208 分别负责公共视图基础、对话复用、文件/变更复用和新协作导航；HC-202 负责装配。各任务按接口、目录归属并行，云端认领材料保持仓库相对引用。接口前置、最小实现前置与真实集成前置分开记录，不能都等上游整个任务完成；详见 docs/developer/project/协作任务并行开发约定.md。

2026-11-10 调度更新：HC-197 等 ACP 协议工作由同事开发。本轮统筹不另行派发 ACP 实现；其他卡中涉及 ACP 的协议、适配、接线、调试和验证，也须等同事完成并交付代码后再安排。非 ACP 的界面、云端交接/引用、独立文件/Git 服务可以按原流程推进；受控界面预览和服务验证不证明 ACP 已接通。具体可做/等待范围以 docs/developer/project/协作任务并行开发约定.md 第 0 节为准，覆盖下文及历史任务中仅接口评审后即可并行开展 ACP 工作的安排。

## 发布阶段与兼容性原则

当前尚未正式发版，Python、TypeScript、Protocol、SQLite 以及内部模块之间没有外部兼容承诺。所有改造以消除技术债和保持单一 canonical 路径为第一优先级：不要为了旧内部 API、旧类名、旧参数、旧测试入口或旧数据形状保留 alias、wrapper、fallback、双写或死分支；应直接迁移调用方和测试并删除旧实现。只有用户或当前任务明确要求，或安全/数据不可逆风险确实需要时，才引入兼容或迁移逻辑，并在对应 Task 中说明原因和退出条件。

## 开发者文档目录体系

面向开发者的过程文档只存放在 `docs/developer/`，按职责拆分如下：

| 目录 | 职责 | 文档命名 |
|------|------|----------|
| `docs/developer/task/` | 功能源头：需求确认、范围、验收标准与看板状态 | `HC-XXX-功能简介.md` |
| `docs/developer/spec/` | 与 Task 一一对应的行为规格与接口定义 | `HC-XXX-功能简介.md`（与 Task 同名） |
| `docs/developer/plan/` | 与 Spec 对应的实施计划，明确标出可演示停点 | `HC-XXX-功能简介.md`（与 Spec 同名） |
| `docs/developer/todo/` | 与 Plan 对应的可执行清单，按可演示停点成节 | `HC-XXX-功能简介.md`（与 Spec 同名） |
| `docs/developer/architecture/` | 大功能长期架构说明（一个大功能一份 Markdown，非 ADR） | 按大功能主题命名，中文 |
| `docs/developer/research/` | 竞品源码对照调研（服务于 Spec 与架构决策） | `XXX-功能简介.md` |
| `docs/developer/project/` | 工程工作流、变更检查清单、依赖清单等跨功能文档 | 按主题命名 |

### 编号与命名规则

- **前缀与编号**：固定为 `HC`（Harness Code），三位数字延续既有编号，不足三位左侧补零（如 `HC-140`）。
- **功能简介**：必须包含中文功能简介，简短克制，**不超过 15 个汉字**，直接体现在文件名中。
- **一致性**：同一功能的 Task / Spec / Plan / Todo **文件名完全一致**，便于检索与交叉引用。
- **示例**：`docs/developer/task/HC-140-斜杠命令补全.md`、`docs/developer/spec/HC-140-斜杠命令补全.md`。

### 文档表达要求

Task / Spec / Plan / Todo 必须通俗易懂，让不熟悉实现的开发者也能直接检视：
- 先用通俗语言说明现状痛点、解决思路与改后收益；
- 复杂流程优先写成通俗的 `输入 → 判断 → 执行 → 输出` 逻辑链路；
- 技术名词首次出现时必须说明用途，不得只堆砌类名和接口代替方案；
- 验收标准必须是可观察的具体结果（如界面的颜色、特定终端输出、测试通过项），避免“完成重构”等无法验证的表述。

## 功能开发流程（双轨制）与 Skill 规范

按需求体量分两条路径推进：复杂功能走完整文档链；简单需求走快速通道。

### 1. 复杂功能：完整流程

```text
task ──> spec ──> plan ──> todo ──> implement ──> review
```

| 阶段 | 产出位置 | 核心职责 | 推荐与强制 Skill |
|------|----------|----------|------------------|
| **task** | `docs/developer/task/` | 需求深度确认、用户收益边界、验收标准、看板登记 | `mattpocock:grill-me` |
| **spec** | `docs/developer/spec/` | 行为规格、接口契约、状态机、错误语义、invariant | `agent-skills:spec-driven-development`<br>`mattpocock:codebase-design` |
| **plan** | `docs/developer/plan/` | 依赖有序的步骤、**标出可演示停点**（用户可见变化） | `agent-skills:planning-and-task-breakdown` |
| **todo** | `docs/developer/todo/` | 可勾选的执行项，按可演示停点分节，标明查看方式 | `agent-skills:planning-and-task-breakdown` |
| **implement** | 生产代码与测试 | 仅实现已确认 Todo；严格 TDD；到达停点立即停下 | `agent-skills:test-driven-development` |
| **review** | 结论写回 Task | 对照 Task/Spec/验收项检视 diff、测试覆盖与文档 | `agent-skills:code-review-and-quality` |
| **辅助** | 视场景按需调用 | 领域建模、原型验证、缺陷排查、解决合并冲突 | `mattpocock:domain-modeling`<br>`mattpocock:prototype`<br>`mattpocock:diagnosing-bugs`<br>`mattpocock:resolving-merge-conflicts` |

### 2. 简单需求：快速通道

改动有限、不触碰核心契约的需求，对话内确认需求后直接实现（无需创建 task/spec/plan/todo 过程文档）：

```text
需求确认（对话内） ──> implement（TDD） ──> 验证 ──> 提交
```

**快速通道准入判据（全部满足方可使用，任一不满足必须回完整流程）**：
- **单包内改动**：不改动跨进程协议（protocol）、SQLite schema、公开接口或核心数据形状；
- **改动面小**：生产源码改动不超过 3 个文件（测试代码与文档不计）；
- **需求明确**：对话内已无未决歧义，不需要方案权衡或竞品调研；
- **不改变行为边界**：不改变交互流程、错误语义或既有安全策略。

**质量底线**：快速通道豁免的是过程文档，不是质量底线。仍须编写最小失败测试（TDD），必须通过包级与项目级检查。实现中一旦发现改动越界，立即停止并转入完整流程。

## Agent 开工规约与流程不变量

Agent 接受任务后，必须严格遵循以下开工顺序与不变量约束：

1. **体量判定与输入对齐**：先按判据判断走快速通道还是完整流程。复杂功能先阅读 `README.md`、`docs/developer/architecture/架构总览.md` 以及对应编号的 Task / Spec / Plan / Todo，确认当前所处阶段。
2. **工作区保洁**：首先执行 `git status --short`，识别并保留用户既有改动，严禁为清理工作区而擅自回滚无关文件。
3. **顺序不可跳**：无确认的 Task 不写 Spec；无确认的 Spec 不写 Plan；无 Todo 不进入实现。
4. **单一事实源与范围锁定**：用户结果以 Task 为准，行为契约以 Spec 为准，步骤以 Plan 为准，执行以 Todo 为准。执行 Agent 严禁自行扩大范围或修改公开 interface；发现冲突时立即停止，回写阻塞点并修订上游文档。
5. **按变更归属选包**：界面与终端交互改 `cli`，跨进程通讯契约改 `protocol`，Agent 运行时与业务改 `agent`。
6. **按停点交付（核心底线）**：
   - 每次实现只推进到下一个可演示停点（用户能看见实际效果的工作包）；
   - 到达停点后勾选对应 Todo，向用户说明如何观察（如 `npm run dev` 看哪块）并**立即停下等待用户确认**；
   - **严禁为了清空清单而一次性连做整份 Todo**。
7. **架构增量同步**：任务完成后检视 `docs/developer/architecture/`，对引入的新边界新建架构文档，或对已有架构文档进行增量修订。

## 代码导航与工程结构

### 代码导航（CodeGraph 优先）

仓库根目录已建立 CodeGraph 图索引（`.codegraph/`）。需要定位、理解或修改代码时，**优先使用 CodeGraph 工具**（MCP `codegraph_explore` 或 shell `codegraph explore`），一次获取逐行源码、调用拓扑与影响面，避免盲目使用 grep/read 消耗大量 Token。仅在配置、文档或待重新索引的文件上回退到 read/grep。

### 项目结构与职责边界

- `apps/desktop/`：Electron main/preload/renderer 装配与受限原生端口。
- `apps/runner/`：执行器装配骨架，当前不自动启动。
- `packages/workbench-ui/`：通用 React 基础工作台，不直接依赖 Node/Electron。
- `packages/workbench-contracts/`：独立平台端口类型，不回引旧 Harness 协议。
- `packages/runner-core/`、`packages/acp-runtime/`、`packages/project-service/`：后续执行器、ACP、文件/Git 的独立包骨架。
- `scripts/workbench/`：新平台依赖边界检查；`scripts/project/`：文档、Task、版本管理。
- `docs/user/`、`docs/developer/`：用户说明与开发过程文档。

代码按新职责落包，代替下文历史流程中按 cli/protocol/agent 选包的旧规则。旧源码只作迁移来源；Harness 专有集成后续由可选包通过公开窄入口接入。依赖以 package exports 为准，禁止跨路径访问内部源码。

### 方案设计参考

下列成熟开源 Coding Agent 源码可用于对照交互体验、事件流、Skill 与会话机制，供 Research 调研参考（不作为本仓库依赖，亦不能覆盖本仓库的架构约束）：
- Oh My Pi、Qwen Code、Codex、DeepAgents、DeepSeek Reasonix、Claude Code、MiMo Code、Grok Build。

## 构建、测试与开发命令

- `npm ci`：按唯一根锁安装新平台，不安装旧 CLI/Python/OpenTUI。
- `npm run dev`：启动 Electron 基础桌面；`npm run build`：构建七个新工程。
- `npm --workspace @workbench/desktop run preview`：运行已构建的本地页面。
- `npm run typecheck`：新工程类型检查。
- `npm run check:boundaries -- --self-check`：新包依赖、公开入口、宿主访问与负例夹具。
- `npm run test:project`：必要工程管理小套；不调用旧全库测试。
- `npm run project:check`：新边界加文档、任务与版本一致性，不前置旧协议。
- `npm run task:claim -- <ID> --owner <名称> --branch <分支>`：认领 Task。
- `npm run tasks:sync`：同步看板；当前实施阶段不调用 task:complete。
- `npm run version:set -- <SemVer>`：唯一版本变更入口，作用于新 workspace；HC-193 不升版。

## 代码风格与命名

- **TypeScript**：ESM，2 空格缩进；变量/函数使用 `camelCase`，类/类型使用 `PascalCase`。协议名保持稳定字符串（如 `stream/text`）。
- **Python**：4 空格缩进；模块/函数使用 `snake_case`，类使用 `PascalCase`，公开 API 必须包含类型注解与 docstring。Python 端 stdout 仅用于输出换行分隔的 JSON-RPC，诊断信息走 stderr 或结构化日志。
- **语言要求**：生产源码及核心类型必须具备中文说明与 docstring/JSDoc。

## 代码注释标准与规范

由于本仓库由 AI 协作研发，代码注释的核心宗旨是**“让人类快速读懂”**，确保不熟悉该源码的开发者能迅速理解业务流程、设计权衡与安全机制。

### 1. 核心撰写原则

- **说人话，禁黑话**：严禁无解释地堆砌抽象架构术语（如 `fail closed`、`composition root`、`draining`、`epoch generation` 等）。若必须引入领域概念，须紧随 1~2 句通俗说明其实质业务意图（例如：“`fail closed`：在超时或断开等异常时，默认采取最保守的拒绝策略，确保未经用户授权绝不擅自执行操作”）。
- **流程结构化表达**：复杂长链条流程优先抽象为通俗的 `输入 → 校验/判断 → 执行 → 终态输出` 步骤呈现，技术细节紧随其后。
- **解释 Why，而非复述 What**：行内注释重点解释“为什么这样做”（防竞态、防死锁、防参数篡改、极端边界兜底），而不是把代码语法用中文重写一遍。
- **适度克制，注重降噪**：对平凡的 getter/setter、标准库单行包装以及自解释的类型别名保持克制，不做形式主义注释，避免淹没核心逻辑。

### 2. 四层分级注释标准

| 层级 | 覆盖对象 | 规范与内容要求 |
|------|----------|----------------|
| **第 1 层：模块头部 (Header)** | 核心源码文件顶部 | 回答“三问”：<br>1. **功能定义**：这个模块是干什么的？<br>2. **协作边界**：它的主要上下游调用方与依赖方是谁？<br>3. **架构流程图**：若是复杂长流程模块，必须附带通俗的 ASCII 架构/时序线框图。 |
| **第 2 层：类与公共接口 (Contract)** | Class、Interface、核心公开方法 | 人性化契约说明：<br>1. 业务目的与生命周期说明；<br>2. 核心入参的业务意义与有效范围；<br>3. 返回值与错误/异常语义（如什么状态下抛出哪些错误、是否可重试）。 |
| **第 3 层：关键行内逻辑 (Why & Invariants)** | 复杂算法、并发控制、安全临界区 | 核心不变量与防护动机：<br>1. 并发锁与死锁预防（如为什么锁只保护状态登记而不跨网络/磁盘 I/O）；<br>2. 竞态防范（如为什么必须先挂事件监听再发网络请求）；<br>3. 安全底线与防篡改（如指纹比对、CAS 版本校验、两阶段提交）。 |
| **第 4 层：降噪与豁免 (Noise Reduction)** | 简单工具函数、平凡属性、生成代码 | 平凡代码免注；自动生成文件、第三方资源或行为命名的单元测试仅保留来源或测试目的说明。 |

### 3. 线框图与流程图粒度（Plan A 方案）

- **严格控制范围**：ASCII 线框图/时序图仅放置在**模块文件头部**以及跨多系统/多阶段的**核心复杂长流程**处（如 Run 全生命周期流转、两阶段文件修改提交、上下文投影与压缩、五阶段工作项引擎、多级安全审批流水线）。
- **细粒度禁止滥用**：细粒度的方法、内部辅助函数及普通小型类，仅使用简练纯文本的人类语言契约，严禁每个小方法都堆砌线框图造成视觉冗余。

## 测试与质量规范

- **命名规范**：Python 测试命名为 `test_<行为>`，Bun 测试命名为 `*.test.ts`。
- **双端覆盖**：修改 IPC 通讯时，必须同时覆盖 Python 端派发/流式行为与 TypeScript 帧处理。
- **环境隔离**：优先使用 mock 模型与 mock 服务，严禁在测试中注入真实模型 API Key；依赖特定宿主端口或未受限权限的 sandbox 限制测试可记录跳过原因。
- **边界覆盖**：服务端生命周期变更必须包含取消、中断恢复、畸形帧与终态错误事件的回归测试。
- **TDD 驱动**：实现阶段必须遵循 TDD（测试驱动开发），先写失败测试，再写最小实现，再行重构。

## Task 规范与归档闭环

### Task Front Matter（最小字段规范）

```yaml
---
id: HC-XXX
title: 功能简介（中文，≤15 字）
feature_area: 稳定的功能板块名称
priority: P0
status: 待认领
owner: 未认领
branch: -
scope: 要完成的范围
acceptance: 可验证的验收结果
user_docs: 不涉及或具体路径
developer_docs: 对应 spec/plan/architecture 路径
test_evidence: -
references: -
completed_at: -
---
```

- **状态流转**：`待认领` → `进行中` → `待验收` → `已完成`（或 `阻塞` / `已过时`）。
- **认领与分支**：分支统一命名为 `feat_hc_XXX_功能简介`，通过 `npm run task:claim -- <ID> --owner <名称> --branch <分支>` 登记。
- **看板同步**：活动 Task 维护在 `docs/developer/task/HC-XXX-….md`，看板由 `docs/developer/task/任务看板.md` 统一汇总呈现。

### 功能完成与归档定义（7 项硬性标准）

一个功能只有同时满足以下条件才算交付完毕：
1. **Todo 兑现**：Plan 与 Todo 清单项已全部勾选，代码实现完毕；
2. **测试证据**：所有相关自动化测试通过，命令与输出证据记入 Task；
3. **Review 闭环**：使用 `agent-skills:code-review-and-quality` 复核 diff，结论写回 Task；
4. **用户文档**：用户可感知变更已更新至 `docs/user/`；
5. **架构同步**：架构/协议/配置变更已增量同步至 `docs/developer/architecture/`；
6. **版本管理**：若涉及版本变更，唯一通过 `npm run version:set -- <SemVer>` 修改；
7. **任务归档**：执行 `npm run task:complete -- <ID> --evidence "..."`，Task 自动移入 `docs/developer/task/archive/` 并从活动看板中剔除。

## 提交、安全与交接规范

- **提交规范**：遵循 Conventional Commit，按包聚焦（如 `feat: Node IPC 客户端`、`fix: handle cancelled agent run`）。合并冲突使用 `mattpocock:resolving-merge-conflicts`。
- **安全底线**：严禁提交 API Key 或凭据。模型 Key 优先走环境变量引用；工作区路径、MCP 响应、Shell 输出均须按不可信输入防御。
- **交接记录 (Handoff)**：非强制要求，由用户按需在对话中明确要求时生成，或由开发者按需手动维护。若生成 `tmp/handoff.md`（本地忽略文件，不提交），内容包含：当前 Task 编号与阶段、改动边界、已完成验证、下一步行动与建议 Skill。已有文档只引路径不重复抄录。

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

Run `openwiki code --update --print` after repository changes to refresh affected wiki pages. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
