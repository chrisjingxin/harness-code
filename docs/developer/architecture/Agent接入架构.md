# Agent 接入架构

本文是桌面协作工作台接入各种 Coding Agent 的长期指导原则（2026-11-07 用户确认）。凡是涉及「平台怎样和 Agent 通信」「某个功能该放在哪一层」「要不要自定义扩展」的设计，都以本文为准；具体任务的 Spec 只能在本文的约束下细化，不能另起规则。

相关文档：[ACP 通信](ACP通信.md)（Harness 一侧的 ACP 实现与缺口表）、[多人协作工作台顶层设计](多人协作工作台顶层设计.md)（平台整体包结构）、[HC-200 Spec](../spec/HC-200-Harness独立ACP接入.md)（Harness 作为 ACP Agent 的规格）。

---

## 1. 背景：为什么只能靠标准 ACP

企业内会有多个 Coding Agent。它们大多是在开源项目上魔改出来的，比如基于 Cline、Pi、Qwen Code，做了企业内的模型、认证、工具适配。这些团队**不一定愿意配合我们**：不会为我们的平台加字段、加方法，也不会按我们的节奏升级。

这些开源上游都已经支持 ACP（Agent Client Protocol，编辑器和 Coding Agent 之间的通用协议）。所以最省事、也最可靠的接入方式是：平台只说标准 ACP，各家 Agent 用它们从上游继承来的 ACP 实现接进来。

由此得出一条总原则：**平台的任何功能，都不能依赖某个 Agent 的配合才能工作。** Harness Code 是我们自己的 Agent，但在平台眼里，它和其他 Agent 一样，只是其中一家。

## 2. 四层结构

```text
① 桌面 UI 层            apps/desktop、packages/workbench-ui
   │  只按「标准 ACP 事件 + 能力」渲染；不认识任何具体 Agent
   ▼
② ACP 协议层            packages/acp-runtime
   │  标准 ACP 客户端全集 + 协议兼容垫片（按协议/SDK 版本，不按 Agent）
   ▼
③ Provider 适配层       每个上游家族一份描述，放在平台侧，可选
   │  启动方式、认证、家族识别、已知差异折算、可选的 _meta 解读
   │  ├─ harness（默认 Provider）  ├─ cline 家族  ├─ pi 家族  └─ qwen 家族 …
   ▼
④ Agent 进程            各家自己的 ACP 实现（含企业魔改版）
      harness acp / cline --acp / pi-acp / qwen --acp …
```

| 层 | 负责 | 禁止 |
|---|---|---|
| ① UI | 按②给出的能力决定显示什么：会话列表、配置项（模型、思考级别等）、模式、`plan` 进度、表单、命令菜单。Agent 没宣告的能力就不显示对应入口 | 按 Agent 名称写分支；写死斜杠命令；假定某项能力一定存在；直接解读任何 `_meta` |
| ② ACP 协议层 | 完整实现标准 ACP 客户端；对 SDK 版本差异和 UNSTABLE 能力做统一容错；把 `_meta` 原样交给③中已注册的解读器 | import 任何 Provider 的类型；为某个 Agent 写特殊逻辑 |
| ③ Provider 适配 | 每个上游家族一份描述（§4）；不需要对方改代码 | 让平台读取 Agent 的数据库、配置文件或内部对象；把某家的私有概念放进①②的公共类型 |
| ④ Agent 进程 | 各家自带 ACP 实现。Harness 的由 [HC-200](../task/HC-200-Harness独立ACP接入.md) 交付 | — |

依赖方向只能向下。①不知道③的存在，只消费②的通用事件；③的 `_meta` 解读器产出的增强信息，通过②的通用扩展槽交给①显示，缺了它①照常工作。

### 2.1 代码组织：目录按层划分

代码的目录结构也按四层组织，一眼能看出每个文件属于哪一层：

```text
apps/desktop/                     ① 装配：唯一知道注册了哪些 Provider 的地方
apps/runner/                      ① 装配（执行器侧），同上
packages/workbench-ui/            ① 通用界面
packages/workbench-contracts/     ①②③ 共用的公共类型与通用扩展接口（不含任何 Agent 的类型）
packages/acp-runtime/             ② ACP 协议层：标准客户端、协议兼容垫片、一致性测试工具
packages/providers/               ③ Provider 适配层，每个家族一个子目录
  harness/                           默认 Provider（包名 @workbench/harness-provider）
  cline/  pi/  qwen/  …              其他家族（按需新建）
packages/agent/                   ④ Harness Agent 进程（默认 Agent，Python）
                                     其他家族的 Agent 进程是外部制品，不进本仓库
```

| 目录 | 能依赖 | 不能依赖 |
|---|---|---|
| ① `workbench-ui` | `workbench-contracts` | `acp-runtime` 内部、任何 `providers/*`、`packages/agent` |
| ① `apps/*` | ①②的公开入口；按需注册 `providers/*` | `packages/agent` 的源码（只能把它当子进程启动） |
| ② `acp-runtime` | `workbench-contracts`、官方 ACP SDK | 任何 `providers/*`、`packages/agent` |
| ③ `providers/<家族>` | `workbench-contracts`、`acp-runtime` 的公开扩展接口 | 其他家族的 Provider；`workbench-ui` 内部；Agent 的源码或数据文件 |
| ④ `packages/agent` | 自己的依赖 | 任何平台包（①②③）；与平台只在 ACP 进程边界通信 |

每个 Provider 子目录内部固定分三块，只有 `descriptor` 是必需的：

```text
providers/<家族>/
  descriptor   启动命令、认证、家族识别、差异折算、已知限制（纯数据，不依赖 Node/React）
  runtime      可选：该家族 `_meta` 的解读器、专有方法处理（Node 侧）
  ui           可选：该家族的专有视图（React 侧，经通用扩展槽加载）
```

Harness 的 Provider 就是 `providers/harness/`，其中 `runtime`、`ui` 承载 Trace、专有设置和 `_meta.harnessCode` 的解读（见 [HC-201](../task/HC-201-Harness轨迹与设置扩展.md)）。

**④ 的物理位置**：Harness Agent 目前在 `packages/agent`，被旧 CLI 等约 150 个文件引用。现在搬到按层命名的目录（例如 `agents/harness/`）成本高、收益小。等 HC-203 退役旧入口、旧引用消失后，再评估是否搬迁。在那之前，`packages/agent` 就是 ④ 层中的默认 Agent。

**不属于任何一层的目录**：`packages/cli`（含 `acp-web` 测试客户端）和 `packages/protocol` 是旧入口和迁移来源，随 HC-203 退役。新代码不能放进去，也不能被①②③依赖。

依赖边界由 `npm run check:boundaries` 检查。新建 `packages/providers/` 的任务要同步扩充检查规则：通用包不能 import 任何 `providers/*`，各 Provider 之间也不能互相 import。

## 3. 一个功能该放在哪里：决策顺序

设计任何功能时，按下面的顺序找落点，找到第一个能满足的就停：

```text
1. 标准 ACP 已有对应方法或字段          → 用标准（①②实现，所有 Agent 受益）
2. 标准有，但各家版本或实现有差异        → ②的协议兼容垫片统一处理
3. 功能可以不依赖 Agent 完成             → 上移到平台（§5），所有 Agent 受益
4. 只有某个家族的上游已经自带            → ③该家族的 Provider 描述里折算或解读
5. 只有我们自己的 Agent（Harness）能做   → Harness 的 `_meta.harnessCode` 扩展
                                           只作增强显示，不能是必需流程
```

几条推论：
- **第 5 步是最后手段。** 扩展只在 Harness 上生效，别家永远不会有。想让所有 Agent 都有的体验，只能走 1～3 步。
- **扩展只能附加信息，不能承载必需流程。** 客户端不声明扩展时，Harness 的每个功能仍要能用标准 ACP 完整走通，只少增强显示。
- **没有标准方法的用户操作，优先做成 Agent 宣告的斜杠命令。** 命令通过标准 `available_commands_update` 宣告，客户端把 `/名称 参数` 当普通 prompt 发送。Cline、Pi、Qwen 都这样做内置命令。这样不需要新方法，任何客户端都能调用。
- **没宣告的能力就不能依赖。** 一切以 `initialize` 返回的能力为准，客户端和 Agent 两个方向都适用。

## 4. Provider 适配层

### 4.1 按上游家族写，不按企业魔改版写

企业魔改版通常保留上游的 ACP 层，只改模型、认证和工具。所以一份家族描述能覆盖同一上游的多个企业 Agent。某个魔改版改出了差异，就在描述里加一条配置项，不改①②。

一份 Provider 描述包含：

| 项 | 内容 |
|---|---|
| 启动 | 命令、参数、环境变量、工作目录约定 |
| 认证 | 走标准 `authenticate`，还是依赖 Agent 自己的登录状态 |
| 识别 | 用 `initialize` 返回的 `agentInfo`（名称、版本）匹配家族 |
| 差异折算 | 把已知的非标准或旧式行为折算成标准概念。例：同时宣告了旧式 `models` 和新式 `configOptions` 时只取后者 |
| `_meta` 解读器（可选） | 只解读该家族上游自带的 `_meta` 字段，产出②的通用扩展事件 |
| 已知限制 | 一致性测试（§6）测出的不支持项，供①提前隐藏入口 |

Provider 描述是可选的。没有描述的 ACP Agent，也能以「纯标准」方式接入，只是没有差异折算和增强显示。

### 4.2 已知上游（2026-11-07 核实，以上游公开文档为准）

| 家族 | ACP 入口 | 上游已有的标准能力（不完全列举） | 来源 |
|---|---|---|---|
| Harness Code（默认 Provider） | `harness acp`（Python，官方 SDK 0.12.1） | 见下方能力矩阵。不声明 `_meta.harnessCode` 时功能仍走标准 ACP，只少增强显示 | 本仓库，2026-11-11 官方 SDK 实测 |
| Cline | 内置 `cline --acp`（官方 TS SDK） | 会话、`plan`/`act` 模式、切模型、取消、审批 | [cline/docs/usage/acp.mdx](https://github.com/cline/cline/blob/main/docs/usage/acp.mdx) |
| Pi | 社区适配器 `pi-acp`，有两个实现：一个拉起 `pi --mode rpc` 转接，一个内嵌 pi SDK | 结构化 diff、`configOptions`（模型、思考级别）、`usage_update`、`session/list/load/resume/close`、`/skill:` 命令 | [svkozak/pi-acp](https://github.com/svkozak/pi-acp)、[victor-software-house/pi-acp](https://github.com/victor-software-house/pi-acp) |
| Qwen Code | 内置 `qwen --acp`（已从实验转稳定） | 会话、审批、`fs/*` 反向请求；上游另有 `acp-bridge` 托管多会话 | [Qwen Code 架构文档](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/) |

Harness 能力矩阵按 §6 的八列整理。自动化用脚本化模型，不调用真实接口。真实模型的页面记录在 [HC-200 Task](../task/HC-200-Harness独立ACP接入.md) 的 S2～S5，两者分开。

| 测什么 | Harness 实测 |
|---|---|
| 握手与能力 | `initialize` 先完成再处理会话请求。宣告读会话、列表、恢复、关闭、附加目录、内嵌上下文、HTTP MCP，以及 `models.select`。不宣告图片、音频、SSE MCP。扩展能力：`approval`、`runSummary`、`sessionSummary`、`subagent`、`goal`、`commands`。`elicitation.form` 是 UNSTABLE 标准能力，不是扩展 |
| 会话 | `session/new`、`load`、`resume`、`close`、`list`。列表每页 50 条，游标非法回 `INVALID_CURSOR`。`load` 回放历史；同一条连接上的 `resume` 不回放。恢复和关闭需要客户端打开 UNSTABLE |
| 运行 | 流式正文、思考、工具卡从开始到结束。取消后 `stopReason` 为 `cancelled` |
| 人工交互 | 审批选项、目录信任、标准 diff。声明 `elicitation.form` 时有提问、计划确认、目标确认和「拒绝并反馈」；批准计划后回到进入前的模式。不声明时不暴露 `plan`（`set_mode` 回 `UNKNOWN_MODE`），提问得到「当前客户端不支持提问」，其余路径仍可切模型、取消、resume |
| 配置与用量 | `configOptions` 有 `model` 和 `workflow`。切换只影响下一轮。用量走 `usage_update` 和 `PromptResponse.usage`。目录为空时不给模型项 |
| 内容 | 文件变更带标准 `diff`。`locations` 覆盖已授权的工作区外目录。`resource_link` 在授权根内读入模型输入，记录只留 `@路径`；单文件 10 KB、单轮 20 KB |
| 命令 | `session/new` 和 `session/load` 之后必发命令表，空表也发。内置命令：`compact`、`btw`、`undo`、`redo`、`title`、`goal`、`abandon`，以及 `skill:` 开头的 Skill。没有表单能力时不宣告 `/goal` |
| 健壮性 | 畸形帧、超大帧有错误响应且连接继续。stdout 只有 ACP 帧。断开 stdin 后进程退出。官方 SDK 端到端：`test_sdk_client_without_extensions_walks_question_plan_model_cancel_and_resume`（有表单、无扩展）和 `test_sdk_client_without_forms_refuses_plan_and_still_switches_cancels_and_resumes`（无表单、无扩展） |

还没达到、且用户已决定暂缓的性能目标：冷启动到 `initialize` ≤ 0.6 秒，真实线程库上的 `session/list` ≤ 0.1 秒。数字见 [ACP 通信](ACP通信.md) 的性能基线。文件树和 Git 不在这张矩阵里，它们归平台。

这张表只是上游的公开情况。企业魔改版有没有改动 ACP 部分（关掉、加私有字段、换 SDK 版本），接入前必须用 §6 的一致性测试实测，结果记进该家族的 Provider 描述。

## 5. 能上移到平台的功能

对方不配合，靠 Agent 提供的增强就只有 Harness 有。所以凡是不需要 Agent 参与就能完成的功能，都放在平台做，让所有 Agent 都能用上：

| 功能 | 平台怎么做 | 仍需 Agent 的部分 |
|---|---|---|
| 文件树、Git 变更与提交 | project-service 直接读工作区 | — |
| 代码回退 | 平台在每轮前后打 Git 快照，按快照回退文件 | 对话历史回退只有 Agent 能做；Agent 没有对应命令时，只回退代码并提示用户 |
| 跨 Agent 的会话列表、标题、摘要 | 平台记录自己的会话元数据 | Agent 的 `session/list` 只作为「能否恢复」的入口 |
| `@文件` 上下文 | 平台读文件，按标准 `resource` 内容块发送 | Agent 没声明 `embeddedContext` 时，平台退化为发送文本 |
| 输入历史、草稿 | 平台本地保存 | — |
| Trace / 运行轨迹 | 不上移 | 只有在 Provider 描述里提供了日志解析的家族才有，平台不承诺所有 Agent 都有 |

上移的前提是**不读 Agent 的私有数据**：平台只用工作区文件、Git，以及 ACP 上流过的标准事件。

## 6. ACP 一致性测试

每接入一个 Agent（包括企业魔改版），先用同一套脚本跑一遍 ACP 一致性测试，产出一行能力矩阵：

| 测什么 | 例子 |
|---|---|
| 握手与能力 | `initialize` 宣告了哪些能力；流水线发送时每个请求是否都有响应 |
| 会话 | new / load / resume / close / list 与分页；恢复时历史是否重复 |
| 运行 | 流式文本与思考、工具卡生命周期、取消后的终态 |
| 人工交互 | 审批选项、`elicitation` 表单、模式切换 |
| 配置与用量 | `configOptions`、`usage_update`、`PromptResponse.usage` |
| 内容 | `diff`、`locations`、`resource` / `resource_link` |
| 命令 | `available_commands_update` 是否发送、何时发送 |
| 健壮性 | 畸形帧、超大帧、断开 stdin 后是否退出、stdout 是否只有 ACP 帧 |

规则：
- 测试脚本只用标准 ACP，不带任何 Agent 的私有知识，放在②这一层（`packages/acp-runtime`）维护。
- 结果写进 §4.2 表格和该家族的 Provider 描述；①据此提前隐藏不支持的入口。
- 自动化测试用 mock 模型或回放；真实模型的互通测试单独记录，两者不能互相替代。

## 7. Harness Code 的定位

- **默认 Agent 与默认 Provider**：④ 层的默认 Agent 是 Harness（`packages/agent`）；③ 层对应的默认 Provider 是 `packages/providers/harness/`。桌面首次使用时预选 Harness，并注册它的 Provider 描述和 `_meta.harnessCode` 解读器。
- **不是必需依赖**：不安装 Harness 时，平台照样能接其他 Agent，Python 不进入基础平台的安装和构建。
- **没有特权路径**：除了 `_meta.harnessCode` 的增强显示外，Harness 和其他家族走完全相同的①②代码。平台为 Harness 写的任何特殊分支都违反本文。
- **扩展命名空间就用 `harnessCode`**：别家不会实现我们的扩展，所以不设计「企业通用扩展规范」。`harnessCode` 只在 Harness 上生效；协商规则见 [ACP 通信](ACP通信.md)「扩展约定」。
- **Harness 自己的功能也按 §3 的顺序设计**：想让平台上所有 Agent 都有的体验，Harness 也要先走标准 ACP 或上移到平台，不能先做成 `harnessCode` 扩展再说。

## 8. 接入一个新 Agent 的步骤

```text
1. 确认它基于哪个上游家族；没有家族就按「纯标准」接入
2. 跑 §6 一致性测试 → 得到能力矩阵
3. 已有家族：在 `packages/providers/<家族>/descriptor` 里补差异配置；新家族：新建 `packages/providers/<家族>/`
4. 只有确需解读该家族上游自带的 _meta 时，才写解读器
5. 真实模型互通一次，记录结果
6. 全程不改 ① UI 层；如果发现非改①不可，说明②或本文漏了通用能力，先修订本文
```
