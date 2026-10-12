# Fusion 双模型使用指南

这份指南用于本地 Build 模式，按照当前源码中的配置、命令和状态编写。先跑一次演示，再把同样的用法用于自己的项目。

Fusion 的分工是：

```text
你提出需求 → Lead 理解和派单 → Sidekick 修改文件
           → Host 运行检查 → Lead 审阅 → 完成，或让 Sidekick 返工
```

**配置两个模型后，还需要在 Harness 输入框里执行 `/fusion <组合名>` 才会启用双模型协作。** 普通模式的默认模型即使叫 `lead`，仍然会自己修改文件。

## 1. 首次体验：从启动到完成

### 1.1 确认准备条件

- 本机已经安装项目依赖；首次安装按 [快速开始](快速开始.md) 操作。
- Lead 服务已启动：`http://127.0.0.1:8788/v1`。
- Sidekick 服务已启动：`http://127.0.0.1:8789/v1`。
- `~/.harness/config.toml` 中已有 `lead` 和 `sidekick` 模型配置及可用密钥。缺少时按第 3 节补齐。
- 系统终端中可以执行 `python3`，用于运行演示项目的检查。

下面的源码路径按当前本机填写。其他机器需要把两处 `harness-code` 路径替换成自己的源码目录。

### 1.2 在系统终端启动 Harness

下面创建独立的演示目录，并加载 [首次验收配置](examples/fusion-verify.toml)。该配置只增加 `verify` 组合和检查命令，模型及密钥沿用用户配置。

```bash
cd /Users/wangdalin/WebstormProjects/20261008/harness-code
mkdir -p /private/tmp/harness-fusion-demo

npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- --cwd /private/tmp/harness-fusion-demo --config /Users/wangdalin/WebstormProjects/20261008/harness-code/docs/user/examples/fusion-verify.toml'
```

`--cwd` 决定模型读取和修改哪个项目。源码开发时要明确填写：`npm run dev` 会进入 CLI 包目录执行，单纯在仓库根目录运行命令不等于模型使用仓库根目录。

演示目录建议第一次使用时为空；再次独立验收可换一个新目录。这里的目录只保存演示代码，使用文档和示例配置保存在仓库中。

### 1.3 在 Harness 输入框启用 Fusion

以下命令输入到 Harness 界面的底部输入框，按 Enter 提交。

1. 确认工作模式是 **Build**；空闲且没有浮层时，按 `Tab` 可以切换 Build / Compose。
2. 审批模式使用 `default`，按提示审批。若显示 `plan`，先用 `Shift+Tab` 切换审批模式；已有活动 Goal 需要先处理。
3. 输入：

```text
/fusion verify
```

应看到：

```text
已选择 Fusion verify：Lead lead，Sidekick sidekick。发送需求开始。
```

这一步只是选中组合。**接下来发送开发需求，才会开始调用模型。**

### 1.4 发送一个需要写文件的任务

把下面内容完整发送到同一个 Harness 对话中：

```text
请使用 Fusion 完成下面的任务：

1. 新建 calculator.py，实现 add(a, b) 和 divide(a, b)。
2. 支持整数、负数和小数；除数为零时抛出 ValueError。
3. 新建 tests/test_calculator.py，使用 unittest 编写至少 8 个测试，不添加第三方依赖。
4. 只允许修改 calculator.py 和 tests/test_calculator.py。allowed_paths 使用项目相对路径；文件可以不存在，由 Sidekick 创建。
5. Lead 使用 fusion_delegate 派单，Sidekick 写文件并通过 fusion_submit_result 提交报告。
6. Host 必须运行已配置的 calculator-tests 检查；失败则让 Sidekick 返工。
7. Lead 逐项审阅并通过 fusion_review_result 接受后，才能宣布完成。
8. 自测使用 python3 -B，避免生成额外缓存文件。
```

派单、写文件或执行命令需要审批时，按界面提示处理。`allowed_paths` 由 Lead 填写，表示本任务允许修改的路径；无需你提前创建空文件。

### 1.5 查看结果

在 Harness 输入框输入：

```text
/fusion status
```

完整通过时，应显示类似：

```text
Fusion verify：已完成；Lead lead，Sidekick sidekick；检查及审阅通过；第 1 轮
```

有返工时，轮次可以是 2、3 或更高。演示目录中应出现：

```text
/private/tmp/harness-fusion-demo/
├── calculator.py
└── tests/
    └── test_calculator.py
```

Host 的检查会先运行 Sidekick 编写的测试，再执行配置里固定的 8 项计算检查。预期输出包括 `OK` 和 `独立验收：8 项通过`。该配置只适用于本节的计算器演示。

## 2. 怎样证明两个模型真的协作了

至少核对下面三类证据：

| 核对什么 | 通过时应该看到什么 |
| --- | --- |
| 两个模型都被调用 | Lead 的 8788 服务、Sidekick 的 8789 服务都收到本次任务的请求；或日志里有两个 Profile 的成功调用记录。 |
| 有真实派单和提交 | 出现 `fusion_delegate`、Sidekick 写文件及 `fusion_submit_result`，最后由 `fusion_review_result` 接受。 |
| 检查和审阅都完成 | `/fusion status` 显示“已完成”及“检查及审阅通过”，文件内容与任务要求相符。 |

仅出现“已选择 Fusion”、模型说“完成”，或工具调用显示 `success`，都不能代替以上证据。工具调用成功返回时，其内容仍可能是参数错误。

需要进一步查日志时，在另一个**系统终端**执行：

```bash
cd /Users/wangdalin/WebstormProjects/20261008/harness-code
npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- logs --cwd /private/tmp/harness-fusion-demo --json --limit 10'
```

从输出中找到本次对话的 `thread_id`，再把下面的 `本次thread_id` 换成实际值：

```bash
npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- logs --cwd /private/tmp/harness-fusion-demo --thread 本次thread_id --component agent --event model.started --json --limit 100'

npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- logs --cwd /private/tmp/harness-fusion-demo --thread 本次thread_id --component agent --event model.completed --json --limit 100'
```

第一份记录应分别包含 `fields.profile_id = "lead"` 和 `"sidekick"`；通过 `execution_id` 核对第二份记录中对应的完成事件。开始事件只能证明尝试调用，完成事件才说明调用正常返回。日志默认保存在 `~/.harness/logs/`，缺少记录时也可核对两个服务的访问日志。

这里证明的是配置的两个服务和执行流程。两个 Profile 都配置 `model = "default"` 时，底层实际模型由各自服务决定。

## 3. 模型和组合怎样配置

### 3.1 配置 Lead 和 Sidekick

配置文件是 `~/.harness/config.toml`。已有这些配置时继续使用；补齐缺少的表和字段，不要在同一文件重复粘贴同名 TOML 表。

```toml
[config]
version = 1

[models]
default_profile = "lead"

[models.profiles.lead]
provider = "openai-compatible"
provider_label = "Local Lead"
model = "default"
base_url = "http://127.0.0.1:8788/v1"
api_key_env = "HARNESS_FUSION_LEAD_API_KEY"
capabilities = ["tool-calling", "streaming"]

[models.profiles.sidekick]
provider = "openai-compatible"
provider_label = "Local Sidekick"
model = "default"
base_url = "http://127.0.0.1:8789/v1"
api_key_env = "HARNESS_FUSION_SIDEKICK_API_KEY"
capabilities = ["tool-calling", "streaming"]

[fusion.profiles.default]
lead_profile_id = "lead"
sidekick_profile_id = "sidekick"
check_plan_ids = []
max_rework_rounds = 3
```

`base_url` 填 `/v1`，Harness 会调用 Chat Completions，不要重复追加 `/chat/completions`。`default` 是本例的组合名称；启用时输入 `/fusion default`。

使用环境变量保存密钥时，先在启动 Harness 的同一个系统终端中执行：

```bash
export HARNESS_FUSION_LEAD_API_KEY='填写Lead密钥'
export HARNESS_FUSION_SIDEKICK_API_KEY='填写Sidekick密钥'
```

已有用户级 TOML `api_key` 时可以继续使用，非空环境变量优先。明文 `api_key` 只允许写在用户级配置里；示例验收配置和其他显式 `--config` 文件通过 Profile 引用它。更完整的配置规则见 [模型配置](模型配置.md)。

### 3.2 为自己的项目配置检查

上面的 `check_plan_ids = []` 没有配置 Host 自动检查，结果只能进入审阅，界面可能显示“仅人工审阅”。这不代表测试已经通过。

例如 Python 项目已有 pytest，可把 `default` 组合的检查列表改为 `["unit"]`，再增加检查计划：

```toml
[fusion.profiles.default]
lead_profile_id = "lead"
sidekick_profile_id = "sidekick"
check_plan_ids = ["unit"]
max_rework_rounds = 3

[fusion.check_plans.unit]
command = "python3 -B -m pytest -q"
cwd = "."
timeout_seconds = 300
```

`command` 应使用你项目实际可执行的测试、构建或检查命令；需要虚拟环境时填写该项目的 Python 路径。`cwd` 是工作区内已存在的相对目录。修改配置后重启 Harness，供新任务使用；运行中的任务不会自动换配置。运行池 `runtime_pool.max_profiles` 至少为 2，默认是 8。

随本指南附带的 `verify` 组合已经配置计算器检查，因此第 1 节直接使用 `/fusion verify`。日常项目使用自己配置的 `/fusion default`。

## 4. 在自己的项目中启动

从 Harness 源码目录运行下面的命令，把工作目录换成目标项目的绝对路径：

```bash
npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- --cwd /目标项目的绝对路径'
```

进入 Build 模式后输入 `/fusion default`，再发送需求。当前源码没有 `--fusion` 启动参数；直接启动仍是普通模式。

已安装 CLI 时，也可用 `harness --cwd /目标项目的绝对路径` 启动，再执行同样的斜杠命令。若项目属于 Git 仓库，工作目录应选该仓库根目录，不能只选其中一个子目录。

需求里说清楚四件事：做什么、允许改哪些路径、怎样检查、什么结果算完成。Lead 可以只读调查和提问；需要修改时交给 Sidekick。简单问答由 Lead 直接回答是正常行为。

## 5. 常用命令与中断恢复

这些命令都输入到 **Harness 输入框**。菜单只有 `/fusion` 一个入口，后面的内容是参数。

| 输入 | 用途 |
| --- | --- |
| `/fusion` | 查看当前任务；没有任务时列出可用组合。 |
| `/fusion default` | 选择用户配置中的 `default` 组合，再发送需求启动。 |
| `/fusion verify` | 选择示例检查组合，需要按第 1 节加载示例配置。 |
| `/fusion status` | 查看阶段、两模型、轮次、验证结果及阻塞原因。 |
| `/fusion off` | 没有活动任务时退出 Fusion。 |
| `/fusion cancel` | 结束活动 Fusion 任务，保留已经修改的文件。 |
| `/fusion recover --stopped 核查说明` | 仅在“结果不明”且已核实相关操作停止后，记录人工恢复。 |

- **暂停后继续：**TUI 的 `Ctrl+C` 或 Web 的停止按钮会中断本次运行，Fusion 任务通常进入暂停状态。在同一个对话里发送“继续原 Fusion 任务”，沿用原任务和 Sidekick 会话。
- **重启后继续：**以原来的工作目录和配置启动，使用 `/resume` 选择原对话，再查看 `/fusion status`。活动任务会恢复原组合。
- **结束并换组合：**先处理或取消活动任务，再选择新组合；要回普通模式则使用 `/fusion off`。
- **结果不明：**先查看待核查操作，检查文件和相关命令、进程。确实确认停止后，才使用 `recover --stopped`。记录后任务暂停，可继续或取消。

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 只有 Lead 自己改文件 | 通常还在普通模式。先提交 `/fusion default` 或 `/fusion verify`，看到选择成功提示后再发需求。普通默认模型叫 `lead` 不会自动启用 Fusion。 |
| 输入 `/` 没看到 Fusion | 在 Harness 输入框输入 `/fu` 搜索。仅 Build 模式显示，空闲时用 Tab 切回 Build。`default`、`status` 等不会分别列成菜单项。 |
| 手动输入提示“未知命令”，或 `/fu` 仍没有匹配 | 保存实际启动命令、工作模式和原样提示；确认运行包含 Fusion 的当前源码并重启。命令还依赖前端与内核协商 `fusion.read` 能力，仅修改 TOML 不能补出旧入口缺少的命令。 |
| 提示“组合不存在” | `/fusion` 查看组合。`verify` 需要显式加载示例配置；只有用户默认配置时通常使用 `default`。 |
| Lead 说自己不能写文件 | Fusion 中的正常分工。要求它用 `fusion_delegate` 派单，让 Sidekick 写文件。 |
| 新文件派单出现 `FUSION_PATH_INVALID` | 使用 `calculator.py`、`tests/test_calculator.py` 等项目相对路径；目录用 `tests/`。新文件可以不存在，不能写成 `/calculator.py`。 |
| Sidekick 服务没有收到请求 | 先看是否启用组合，再看是否派单成功。第 0 轮表示尚未开始有效的 Sidekick 执行；查看 `fusion_delegate` 的返回内容及 `/fusion status`。 |
| 检查失败，或只显示“检查通过，等待审阅” | 失败时由 Lead 安排返工；等待审阅表示 Lead 尚未接受结果，都不能宣布完成。 |
| 显示“仅人工审阅” | 当前组合没有 Host 自动检查。配置有效检查计划并重启，用新任务验证。 |
| `FUSION_SNAPSHOT_UNAVAILABLE` | 核对 `--cwd` 是否为 Git 仓库根目录；首次验收可使用第 1 节的独立演示目录。 |

当前 Fusion 用于本地 Build 普通需求。Compose、活动 Goal、显式 Skill、Plan 审批和远程 backend 不能与它混用。更多操作见 [交互使用](交互使用.md)，通用启动问题见 [故障排查](故障排查.md)。
