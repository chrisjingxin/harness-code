# Fusion 使用指南

Fusion 让两个模型分工完成一个改代码的任务：

| 谁来做 | 负责什么 |
| --- | --- |
| Lead | 看懂你的需求，把写代码的工作交给 Sidekick；代码改完后，再检查是否满足要求。 |
| Sidekick | 按要求修改文件、补测试，有问题时继续修改。 |
| Harness 程序 | 运行你配置的测试命令，保存任务进度。程序里的这部分也叫 Host。 |

整个过程是：

```text
你提需求 → Lead 安排工作 → Sidekick 写代码
         → Harness 跑测试 → Lead 确认结果
```

下面先用一个小例子跑完这个过程，再介绍怎样用于自己的项目。

## 1. 先做一次小实验

这个例子让 Sidekick 写一个计算器，并自动检查结果。

### 第一步：确认模型服务已经启动

本例使用的两个服务是：

- Lead：`http://127.0.0.1:8788/v1`。
- Sidekick：`http://127.0.0.1:8789/v1`。

还需要满足三个条件：

- Harness 的依赖已安装；首次安装见 [快速开始](快速开始.md)。
- `~/.harness/config.toml` 已配置 `lead`、`sidekick` 和对应密钥。没有配置时，先按第 4 节填写。
- 在系统终端里能运行 `python3`，它用来执行本例的测试。

### 第二步：在系统终端启动 Harness

这里的**系统终端**，就是你平时执行 `cd`、`npm` 命令的地方。

复制下面的命令运行：

```bash
cd /Users/wangdalin/WebstormProjects/20261008/harness-code
mkdir -p /private/tmp/harness-fusion-demo

npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- --cwd /private/tmp/harness-fusion-demo --config /Users/wangdalin/WebstormProjects/20261008/harness-code/docs/user/examples/fusion-verify.toml'
```

这条命令做了两件事：

- `--cwd` 指定改代码的目录。本例的文件会放在 `/private/tmp/harness-fusion-demo`。
- `--config` 加载随指南提供的 [演示配置](examples/fusion-verify.toml)。它使用你已有的两个模型，并增加本例需要的测试命令。

如果你的 Harness 源码在其他位置，把命令中的两处源码路径换成实际路径。演示目录第一次使用时应为空；如果已有旧的演示文件，可以换一个空目录，并同步修改 `--cwd`。

### 第三步：在 Harness 输入框开启 Fusion

启动后，在 Harness 界面底部找到输入框，就是你平时给它发需求的地方。**下面的 `/fusion` 命令都在这里输入。**

先看一下界面中的模式：

- 工作模式选 **Build**。空闲时关掉菜单或弹窗，再按 `Tab` 切换。
- 审批模式选 **default**，可用 `Shift+Tab` 切换。操作需要你允许时，界面会提示。
- 如果当前有正在进行的 Goal 目标任务，先处理该任务，再开启 Fusion。

然后输入并按 Enter：

```text
/fusion verify
```

看到下面的提示，就说明已经选好了两个模型：

```text
已选择 Fusion verify：Lead lead，Sidekick sidekick。发送需求开始。
```

接下来发需求，模型才会开始工作。

### 第四步：发一个开发需求

把下面内容复制到 Harness 输入框，发送到同一个对话中：

```text
请用 Fusion 帮我写一个小计算器：

1. 创建 calculator.py，实现 add(a, b) 和 divide(a, b)。
2. 支持整数、负数和小数。除数为零时，抛出 ValueError。
3. 创建 tests/test_calculator.py，用 unittest 写至少 8 个测试，不添加第三方依赖。
4. 只修改 calculator.py 和 tests/test_calculator.py。这两个文件可以由 Sidekick 新建。
5. Lead 把写代码和测试的工作交给 Sidekick。写完后，由 Harness 运行已配置的 calculator-tests 检查。
6. 检查失败就继续修复。全部检查通过，并且 Lead 确认满足上面的要求后，才算完成。
7. 自测使用 python3 -B，避免生成额外缓存文件。
```

接下来按界面提示允许或拒绝操作。Lead 负责安排工作和检查结果，真正写文件的是 Sidekick。

### 第五步：确认任务完成

在 Harness 输入框输入：

```text
/fusion status
```

成功时，会看到类似下面的内容：

```text
Fusion verify：已完成；Lead lead，Sidekick sidekick；检查及审阅通过；第 1 轮
```

重点看 **“已完成”** 和 **“检查及审阅通过”**。如果经过返工，第 1 轮会变成第 2 轮、第 3 轮等，这是正常的。

演示目录里还应有这两个文件：

```text
/private/tmp/harness-fusion-demo/
├── calculator.py
└── tests/
    └── test_calculator.py
```

本例的检查会先运行 Sidekick 写的测试，再运行配置中固定的 8 项检查。预期输出包括 `OK` 和 `独立验收：8 项通过`。

## 2. 怎样确认 Sidekick 确实参与了

### 先看界面里的执行过程

开启 Fusion 并发送开发需求后，终端和 Web 都会在同一页面显示两种过程区，例如：

```text
▼ Lead · default                         等待 Sidekick
  已读取项目代码，准备安排修改。

▼ Sidekick · default · 第 1 轮             执行中
  正在修改文件。
  写文件 answer.py                       运行中
  执行命令 python3 -B -m unittest         运行中
```

Sidekick 结束后，后面会接着出现 Lead 的审阅过程。

- **Lead 区域**显示分析、派单和审阅时的输出与工具记录。
- **Sidekick 区域**显示这一轮已经返回的输出、工具调用和执行结果，执行过程中就会更新。需要返工时，会出现“第 2 轮”等新的过程区。
- 点击区域标题可以折叠或展开；手动折叠后，新输出不会强制展开。工具详情的查看方式与普通模式相同。
- 底部状态行显示当前执行角色。取消或失败后，相关过程会停止显示运行中，已经收到的内容仍可查看。

区域标题后的模型名来自实际配置。如果两个服务的模型名都是 `default`，就用 **Lead / Sidekick** 标签区分。模型只调用工具、没有返回文字时，也会显示工具过程；界面不会生成模型未返回的思考内容。

“本轮执行结束”只表示 Sidekick 这一轮已经结束。整个任务是否完成，仍要看 `/fusion status` 的检查与审阅结果。

这些详细过程会保留在当前程序会话中，切换到 Web 或刷新 Web 后也能继续查看。退出程序或重新打开历史会话后，仍按已有历史记录恢复，目前不会恢复 Sidekick 的逐条过程。

### 再核对模型调用和最终结果

看下面三件事：

| 看哪里 | 应该看到什么 |
| --- | --- |
| 两个模型服务的请求记录 | 本次任务期间，8788 和 8789 都收到请求，说明两个服务都被调用了。 |
| 任务的工具记录 | Lead 把任务交给 Sidekick，Sidekick 修改文件并提交结果，最后由 Lead 确认完成。工具名称见本文末尾。 |
| `/fusion status` 和项目文件 | 状态显示“已完成”和“检查及审阅通过”，文件内容也符合你的要求。 |

“已选择 Fusion”只表示已经开启这组设置。模型回复“完成”时，也要核对上面的结果。工具显示 `success` 后，可以展开返回内容，确认里面没有报错。

几种常见状态可以这样理解：

| 显示的文字 | 你接下来怎么做 |
| --- | --- |
| Sidekick 执行中 | 等它修改代码；有审批提示时按提示处理。 |
| Host 检查中 | Harness 正在运行测试，等待结果。 |
| 检查通过，等待审阅 | 测试通过了，Lead 还在检查是否满足需求。 |
| 检查及审阅通过，同时显示已完成 | 本次改代码任务已经完成。 |
| 仅人工审阅 | 这组设置没有让 Harness 自动运行检查；不能据此认定测试通过。 |
| 已暂停 | 在原对话中发“继续原 Fusion 任务”。 |
| 结果不明，需要核查 | 先按第 5 节检查文件和相关进程，再决定是否继续。 |

## 3. 怎样用在自己的项目上

先确认已经配置好第 4 节的 `default` 这组设置。

在 **Harness 源码目录**打开系统终端，运行：

```bash
npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- --cwd /目标项目的绝对路径'
```

把 `/目标项目的绝对路径` 换成要修改的项目目录。如果项目使用 Git，这里要填写 Git 仓库的根目录。

进入 Harness 后，选择 Build 模式，再在输入框输入：

```text
/fusion default
```

看到选择成功的提示后，直接发送需求。例如：

```text
请给登录接口增加手机号格式校验。
只允许修改登录接口及相关测试。
补充正确号码、错误号码和空号码的测试。
修改后运行项目的测试，通过后再检查是否满足这些要求。
```

说清楚“要做什么、允许改哪些文件、怎么检查、怎样算完成”即可。

已经安装 CLI 时，也可以用 `harness --cwd /目标项目的绝对路径` 启动，再执行同样的 `/fusion default` 命令。

**每次新启动都要确认 Fusion 是否开启。** 直接启动 Harness，或者把普通模式的默认模型设置成 `lead`，都不会自动开启 Fusion。

## 4. 配置怎么填

### 4.1 填写两个模型

打开 `~/.harness/config.toml`。下面是一份完整示例。如果文件里已有相同的配置项，直接修改对应内容，避免重复粘贴同名的 `[配置表]`。

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

这几个名字的含义是：

- `lead`、`sidekick`：给两份模型配置起的名字。
- `model = "default"`：模型服务实际接受的模型名称。
- `[fusion.profiles.default]`：给这组双模型设置起名为 `default`，所以用 `/fusion default` 开启。
- `max_rework_rounds = 3`：第一轮之后，最多再修改 3 轮。

`base_url` 填到 `/v1` 就可以，程序会补上 `/chat/completions`。

使用环境变量保存密钥时，在**准备启动 Harness 的系统终端**里先运行：

```bash
export HARNESS_FUSION_LEAD_API_KEY='填写Lead密钥'
export HARNESS_FUSION_SIDEKICK_API_KEY='填写Sidekick密钥'
```

然后在这个终端启动 Harness。如果已在 `~/.harness/config.toml` 中填写 `api_key`，可以继续使用；环境变量里有密钥时，优先使用环境变量。

直接填写 `api_key` 只支持用户配置 `~/.harness/config.toml`。其他通过 `--config` 加载的文件，引用这里的模型配置即可。详细规则见 [模型配置](模型配置.md)。

### 4.2 告诉 Harness 要运行什么检查

`check_plan_ids = []` 表示没有配置自动检查。想让 Harness 真正跑测试，需要填上检查名称和对应命令。

例如，你的 Python 项目已经安装 pytest，可以把原来的 `[fusion.profiles.default]` 改成下面的内容，并增加 `[fusion.check_plans.unit]`：

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

| 配置项 | 意思 |
| --- | --- |
| `check_plan_ids = ["unit"]` | 使用下面名为 `unit` 的检查。 |
| `command` | 要运行的测试命令，换成你项目实际使用的命令。使用虚拟环境时，填写对应的 Python 路径。 |
| `cwd = "."` | 在启动时 `--cwd` 指定的项目目录运行检查。也可以填写该目录内已经存在的子目录。 |
| `timeout_seconds = 300` | 检查超过 300 秒就停止。 |

修改配置前，先处理正在进行的任务。修改后重启 Harness，再开始新任务。若你修改过 `runtime_pool.max_profiles`，该值至少要为 2；默认值是 8。

第 1 节用的 `verify` 是随文档提供的演示设置，已经有计算器检查。这里的 `default` 用于你自己的项目，两者的名字可以通过 `/fusion` 查看。

## 5. 暂停、继续和退出

这些命令都在 Harness 输入框执行。

| 想做什么 | 怎么操作 |
| --- | --- |
| 查看可用设置或当前任务 | 输入 `/fusion`。 |
| 查看进度 | 输入 `/fusion status`。 |
| 暂停当前运行 | 终端界面按 `Ctrl+C`，或在 Web 界面点停止按钮。 |
| 继续暂停的任务 | 在原对话里发送“继续原 Fusion 任务”。 |
| 重启后继续 | 使用原工作目录和原配置启动，输入 `/resume` 选回原对话，再查看 `/fusion status`。 |
| 结束这个任务 | 输入 `/fusion cancel`；已经修改的文件会保留。 |
| 回到普通模式 | 没有活动任务时输入 `/fusion off`。 |
| 更换双模型设置 | 先完成或取消当前 Fusion 任务，再输入 `/fusion <新的设置名称>`。 |

如果状态是**“结果不明，需要核查”**：

1. 输入 `/fusion status`，查看有哪些操作需要检查。
2. 检查文件，以及相关命令、进程是否已经停止。
3. 确实确认停止后，再输入下面的命令，并写清楚检查了什么：

```text
/fusion recover --stopped 已检查相关文件，并确认相关命令和进程全部停止
```

**每次只输入一条命令，按回车后等待提示。** 恢复成功时应看到“核查已记录，任务暂停”。没有看到这条提示，就表示核查尚未成功记录，应先处理这一步的报错。

看到成功提示后，你可以在原对话中继续；若要结束任务，再单独输入：

```text
/fusion cancel
```

取消成功后，`/fusion status` 应显示“已取消”，已经修改的文件会保留。

如果取消时报 `FUSION_OUTCOME_UNKNOWN`，说明核查尚未完成。重复输入取消命令不会解除占用；请先完成上面的恢复步骤，看到成功提示后再取消。

## 6. 遇到问题怎么办

### 只有 Lead 在工作，Sidekick 没有请求

先看是否出现过“已选择 Fusion”的提示。没有的话，先执行 `/fusion default`，再发送需要修改文件的任务。第 1 节的演示使用 `/fusion verify`。

如果已经开启，但 `/fusion status` 显示“尚未派单”，说明还没有成功把工作交给 Sidekick。先查看状态中的原因；显示工作区占用时，按下文处理占用会话。其他参数问题可展开 `fusion_delegate` 的返回内容，按提示修正。

简单问答由 Lead 直接回答是正常的；需要写代码的任务才会交给 Sidekick。

### 找不到 `/fusion` 命令

依次确认：

1. 命令输入在 Harness 的对话输入框里。
2. 当前工作模式是 Build；空闲时关掉菜单或弹窗，按 `Tab` 切回 Build。
3. 输入 `/fu` 搜索。菜单里显示 `/fusion`，`default`、`status` 等内容是它的参数。

如果仍然没有，或手动输入后提示“未知命令”，保存启动命令和原样提示。确认启动的是包含 Fusion 功能的源码，再重启；还未解决时，把这些信息交给维护者继续排查。

### 提示“组合不存在”

输入 `/fusion` 查看有哪些设置。第 1 节的 `verify` 需要用 `--config` 加载演示配置；用户配置里的 `default` 用 `/fusion default` 开启。

### 派单提示 `FUSION_LEASE_BUSY`，或者显示“工作区被另一任务占用”

这表示同一个项目目录仍由另一项 Fusion 任务使用。即使旧对话已经停止输出，等待处理或暂停的任务仍可能保留写权限。

修复后的界面会显示占用会话、任务阶段和原因。当前任务会进入“等待处理”，本轮不再反复派单。第 0 轮显示为“尚未派单”，这时不能用返工入口代替首次派单。

1. 用 `/resume` 返回提示中的占用会话，再输入 `/fusion status`。
2. 如果旧任务显示“结果不明，需要核查”，先按第 5 节检查文件和进程，再单独输入 `/fusion recover --stopped <核查说明>`，等界面提示“核查已记录，任务暂停”。
3. 如果要保留旧任务，就继续处理它。若决定结束旧任务，在旧会话单独输入 `/fusion cancel`，等状态变成“已取消”；已经修改的文件会保留。
4. 回到当前对话，发送“占用已处理，继续原 Fusion 任务”。占用解除后，程序才会继续派单。

只回答问答卡片，并不会释放工作区。卡片上的“已处理”只表示这次问答结束；Fusion 是否完成，仍以 `/fusion status` 的任务状态和检查、审阅结果为准。

### Sidekick 一直等待模型，或者同一个错误反复出现

先展开 Sidekick 过程，查看最后一条输出或工具结果。底部“本次已运行”统计的是整个 Run，不能当成这一次模型请求的等待时长。

当前版本会做这些处理：

- 一次模型流式响应达到 `timeout_seconds` 就停止，持续心跳也不能延长时限。默认是 120 秒。
- 同一个工具连续三次返回相同的 Fusion 拒绝错误，会保存“受阻”报告并结束这一轮，交给 Lead 后续处理；有成功工具结果或新任务时重新计数。
- 报告提交后立即结束这一轮，直接返回 Lead。Python 代码中的按位 `&` 可以正常检查，真正的后台命令仍会被拒绝。

需要调整等待时间时，在配置文件已有的 `[models.profiles.sidekick]` 表下填写：

```toml
timeout_seconds = 120
max_retries = 1
```

`timeout_seconds` 限制一次流式响应。模型确实需要较长时间才能生成完整代码时，可以增加它；`max_retries = 1` 表示无公开输出的临时故障最多再试一次，设为 `0` 则直接返回失败。重试和多次工具调用都会增加任务总时长。已经显示正文的请求失败后不会自动重放。

更新代码或配置后，先中断当前执行并正常退出，再重新启动 Harness，让 CLI 和 Python Host 加载新代码。进入原会话用 `/fusion status` 查看任务；若显示“结果不明”，按第 5 节先核查停止情况，再恢复。当前卡住的旧进程不会自动加载修复。

### Lead 说自己不能写文件

这是 Fusion 的分工。让它把写文件的任务交给 Sidekick。例如发送：“请把修改工作交给 Sidekick，完成后检查结果。”

### 新文件报 `FUSION_PATH_INVALID`

让 Lead 使用相对于项目目录的路径，例如 `calculator.py`、`tests/test_calculator.py`。目录可以写成 `tests/`。

文件或目录可以由 Sidekick 新建。以 `/` 开头的 `/calculator.py` 不能用于指定允许修改的文件。

如果出现 `FUSION_FIRST_ORDER_REQUIRED`，表示首轮任务单尚未创建，应先用首次派单工具 `fusion_delegate`。返工工具 `fusion_rework` 用于已有任务单的后续修改；它不要求必须已经有审阅票据。

### 检查失败，或者一直显示“等待审阅”

检查失败时，让 Lead 安排 Sidekick 修复后重新检查。“检查通过，等待审阅”表示测试通过了，但 Lead 还没有确认任务完成。

### 报 `FUSION_SNAPSHOT_UNAVAILABLE`

检查启动命令的 `--cwd`。如果项目使用 Git，它应指向仓库根目录。也可以先用第 1 节的独立演示目录排查。

Fusion 目前用于本机项目，工作模式选择 Build，审批模式建议选择 default。正在使用 Goal 目标任务或手动选择的 Skill 时，先处理这些任务，再开启 Fusion。远程沙箱暂不支持 Fusion。

其他界面操作见 [交互使用](交互使用.md)，启动报错见 [故障排查](故障排查.md)。

## 附：需要进一步确认时，查看调用记录

平时用 `/fusion status` 查看进度。想进一步确认两个模型都成功返回了结果，可以查看日志。

在另一个**系统终端**里，先找本次对话的编号：

```bash
cd /Users/wangdalin/WebstormProjects/20261008/harness-code
npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- logs --cwd /private/tmp/harness-fusion-demo --json --limit 10'
```

`thread_id` 是对话编号。找到本次对话后，把下面两条命令中的 `本次thread_id` 换成实际编号：

```bash
npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- logs --cwd /private/tmp/harness-fusion-demo --thread 本次thread_id --component agent --event model.started --json --limit 100'

npx --yes --package=bun@1.3.13 -c \
  'npm run dev -- logs --cwd /private/tmp/harness-fusion-demo --thread 本次thread_id --component agent --event model.completed --json --limit 100'
```

- 第一条查看模型开始调用的记录，里面应有 `fields.profile_id = "lead"` 和 `"sidekick"`。
- 第二条查看正常返回的记录。用 `execution_id`（模型执行编号）把开始和完成记录对应起来。
- 仅有开始记录时，还不能确认调用成功。日志默认保存在 `~/.harness/logs/`，也可以核对两个模型服务的请求记录。

如果两个服务都把模型名设置成 `default`，真正使用哪个模型由各自服务决定。这些记录用于确认调用了哪个服务，以及它是否正常返回。

工具记录里的几个名字可以这样看；这些工具由模型自行调用：

| 工具名称 | 意思 |
| --- | --- |
| `fusion_delegate` | Lead 把任务交给 Sidekick。 |
| `fusion_submit_result` | Sidekick 提交这一轮的结果。 |
| `fusion_rework` | Lead 要求 Sidekick 继续修改。 |
| `fusion_review_result` | Lead 提交检查结果；接受后，改代码任务才算完成。 |
