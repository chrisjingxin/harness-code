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
| 结果不明，需要核查 | 可以直接提问让 Lead 只读核查。需要继续修改时，按第 5 节确认停止情况。 |

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

## 5. 暂停、继续和结束任务

下面的命令都输入在 **Harness 对话框**里，每次输入一条，按回车后等提示。

| 想做什么 | 怎么操作 |
| --- | --- |
| 查看可用设置或当前任务 | 输入 `/fusion`。 |
| 查看进度 | 输入 `/fusion status`。 |
| 暂停当前运行 | 终端界面按 `Ctrl+C`，或在 Web 界面点停止按钮。 |
| 继续暂停的任务 | 在这个任务的原对话里发送“继续”。 |
| 重启后继续 | 使用原工作目录和原配置启动，输入 `/resume` 选回原对话，再查看 `/fusion status`。 |
| 结束当前任务 | 输入 `/fusion cancel`；已经修改的文件会保留。 |
| 主动结束另一任务 | 在当前对话输入 `/fusion resolve`。普通文件冲突会自动等待，通常不需要结束别人。 |
| 回到普通模式 | 当前任务结束后输入 `/fusion off`。 |
| 更换双模型设置 | 先完成或取消当前任务，再输入 `/fusion <新的设置名称>`。 |

暂停、等待处理的任务，如果相关操作已明确停止，会自动交回文件权限。任务和文件仍保留，之后可回原对话继续；恢复时程序会重新申请相应文件，并检查文件有没有变化。

如果是在排队时按了停止，可以按下面的方式继续：

| 在原对话输入 | 程序会做什么 |
| --- | --- |
| `继续等待`、`继续` | 恢复已保存的原任务，可用后自动执行。 |
| `继续返工，把空输入处理修好` | Lead 先处理这条新反馈，再安排 Sidekick 修改。 |
| `为什么还在等？`、`先检查谁占用了文件` | 只查看，不启动 Sidekick。 |

有新要求时直接说明要改什么，程序不会先照旧反馈执行一遍。上面的继续和返工文字都不能解除“结果不明”状态；该状态按下一节核查。

### 显示“结果不明，需要核查”时

这表示某个命令或派发没有留下可靠的停止记录，**不等于程序已经查到进程还在运行**。

你可以直接在原对话输入：

```text
检查这项任务的待查操作属于哪个会话，并查看相关文件。先说明查到了什么、还有什么不能确认。
```

Lead 会进入只读核查：可以读取任务状态和项目文件，直接回答；不会继续派单或改文件，也不会把“自己检查”当成你已经确认进程停止。即使这期间改过模型配置，也可以只读查询；继续修改时仍检查原任务的配置是否一致。

也可以输入 `/fusion status`。即使本会话没有活动任务，状态查询仍会显示其他任务对当前目录的占用。待查操作的会话归属与真实进程是否运行是两件事：旧记录没有 PID 或可靠的停止凭据时，Lead 会说明不能确认，不应编造进程占用结论。

需要继续修改时，再检查文件，以及相关命令和进程是否已经停止。

**确认停止后**，根据目的选择一条命令：

| 你的目的 | 在当前对话输入 |
| --- | --- |
| 结束当前任务 | `/fusion cancel --stopped 已检查文件，并确认相关命令和进程全部停止` |
| 继续当前任务 | `/fusion recover --stopped 已检查文件，并确认相关命令和进程全部停止`，看到“核查已记录，任务暂停”后发送“继续”。 |
| 结束占用目录的另一任务 | `/fusion resolve --stopped 已检查文件，并确认占用任务的相关命令和进程全部停止`，成功后发送“继续”。 |

把例子中的说明换成你实际做过的核查。`--stopped` 是你对停止情况的明确确认，程序不会替你填写。

结束当前任务后，`/fusion status` 应显示“已取消”；处理另一任务成功时会提示相应文件权限已交回。已经修改的文件都会保留。结束任务可以直接用带说明的取消命令完成。

## 6. 同一个项目同时做两个任务

**可以在同一目录开启多个对话。程序按要修改的文件协调任务，无需增加配置。**

| 两个任务在做什么 | 你会看到什么 |
| --- | --- |
| 分别修改 `a.py` 和 `b.py` | 两个 Sidekick 可以同时工作。 |
| 都要修改 `a.py` | 后一个显示“等待文件写入权限”；前一个交回文件后，自动继续。 |
| 一个修改 `src/`，另一个修改 `src/a.py` | 两者范围重叠，自动排队。 |
| 其中一个执行命令或测试 | 命令运行期间，其他实际写入临时等待；确认结束后自动继续。模型仍可分析和读文件。 |
| 某条命令没有可靠的停止记录 | 保留保护并提示核查。不会仅凭“等了很久”就放行写入。 |

### 可以这样试

1. 打开两个系统终端，使用**相同的 `--cwd` 和配置**启动 Harness。
2. 两个对话都输入 `/fusion default`。
3. 对话 A 输入：`只新建 upper.py，实现字符串转大写，不修改其他文件。`
4. 对话 B 输入：`只新建 lower.py，实现字符串转小写，不修改其他文件。`
5. 查看各自的 Sidekick 过程和 `/fusion status`。两项任务的文件范围不同，可以同时派单。

要观察排队，让两个任务都修改同一个文件。后一个应显示自动等待，等前一个完成后自己继续，**不用返回旧会话取消，也不用反复发送“继续”**。

文件范围由 Lead 在派单时填写。范围写成整个目录 `./`，就会与该目录所有文件冲突。希望并行时，可以像上面那样明确指定各自文件；如果两个任务都必须修改 `README.md`，这一部分仍需排队。

检查结果也会跟着代码版本变化：如果另一任务在检查后改了源码，Harness 会重新检查，并交给 Lead 确认新的结果。它不会拿旧测试结果证明新代码通过。

### 从旧版本升级

关闭共用同一 Harness 数据目录（默认 `~/.harness`）的所有旧 Harness 进程，再用最新源码重新启动，原配置可以继续使用。旧数据库会先在同一数据目录生成 `*.before-file-scopes-*.sqlite3` 备份，再迁移权限记录；旧的任务和文件会保留，旧验收票据会重新核对。

旧任务若已有未确认停止的命令，升级后仍需按第 5 节核查一次。进程消失只能说明 Host 无法继续报告，不能证明它启动的命令已经停止。

这些协调适用于共享 Harness 数据目录的本机进程；外部编辑器和自己开的 Shell 不经过这套排队，提交文件时仍会检查版本变化。

## 7. 遇到问题怎么办

### 只有 Lead 在工作，Sidekick 没有请求

先看是否出现过“已选择 Fusion”的提示。没有的话，先执行 `/fusion default`，再发送需要修改文件的任务。第 1 节的演示使用 `/fusion verify`。

如果已经开启，但 `/fusion status` 显示“尚未派单”，说明还没有成功把工作交给 Sidekick。先查看状态中的原因；显示等待文件权限时会自动排队；只有结果不明时才需要按下文核查。其他参数问题可展开 `fusion_delegate` 的返回内容，按提示修正。

简单问答由 Lead 直接回答是正常的；需要写代码的任务才会交给 Sidekick。

### 找不到 `/fusion` 命令

依次确认：

1. 命令输入在 Harness 的对话输入框里。
2. 当前工作模式是 Build；空闲时关掉菜单或弹窗，按 `Tab` 切回 Build。
3. 输入 `/fu` 搜索。菜单里显示 `/fusion`，`default`、`status` 等内容是它的参数。

如果仍然没有，或手动输入后提示“未知命令”，保存启动命令和原样提示。确认启动的是包含 Fusion 功能的源码，再重启；还未解决时，把这些信息交给维护者继续排查。

### 提示“组合不存在”

输入 `/fusion` 查看有哪些设置。第 1 节的 `verify` 需要用 `--config` 加载演示配置；用户配置里的 `default` 用 `/fusion default` 开启。

### 显示“等待文件写入权限”，或者提到其他会话

先查看 `/fusion status`：

- **显示自动等待**：有任务正在使用相同文件或执行命令，保持等待即可。权限可用后会自动继续。按 `Ctrl+C` 可暂停当前等待。
- **显示结果不明、需要核查**：缺少可靠的停止记录，按第 5 节处理。这里只表示停止情况还不能确认，不代表已经检测到进程仍在运行。
- **仍反复报 `FUSION_LEASE_BUSY`**：确认已关闭所有旧 Harness 进程，再从最新源码启动。新实现的普通范围冲突由程序排队，不需要模型反复派单。

如果确实想结束占用任务，可以在当前对话输入 `/fusion resolve`；涉及结果不明的操作时，必须先核查，再附上 `--stopped <实际核查说明>`。文件都会保留。

### 派单反复报 `FUSION_REQUIREMENT_INVALID`

更新后的版本由程序直接保存你的原始需求，Lead 只填写实施步骤和文件范围。你正常描述需求即可，例如“实现一个字符串大小写转换工具类”，无需配合模型改写句子或拆成特殊格式。

更新代码后要正常退出并重启 Harness，正在运行的旧进程不会自动加载修复。如果仍有派单错误，展开 `fusion_delegate` 的结果，查看提示的字段和修正方法；连续同类错误会暂停，不再一直猜参数。

### 列目录后报 `unhashable type: 'dict'`

这是旧版 Fusion 处理文件工具错误时的程序缺陷。已修复：目录读取失败会作为工具结果交给模型，模型可以调整路径继续；读取失败不会再触发这个类型异常。

更新代码后，完全退出并重启 Harness，在原会话发送“继续”。文件工具的项目根路径是 `/`；`/workspace` 只有在项目里确实存在这个目录时才有效。若任务另有“停止情况不明”记录，仍按第 5 节核查。

### 报 `Provider stream failed after output was published`

这是模型输出到一半时连接断了。已显示的内容保留，程序不会自动重放这段响应，已经写入的文件也会保留。

1. 在原对话发送“继续”。已明确停止的执行会按保存的任务继续，由 Lead 读取现状后安排下一步。
2. 如果出现 `FUSION_OUTCOME_UNKNOWN`，可以直接提问，让 Lead 只读查看任务与文件，或输入 `/fusion status`。确认停止后，用 `recover --stopped` 继续原任务，或用 `cancel --stopped` 结束。
3. 如果经常断流，检查模型代理服务的日志和响应时限。下文的 `timeout_seconds` 只能调整本地等待时间，无法修复上游服务主动断开。

程序会从 Sidekick 上一次完整结束的位置继续。第一轮尚未完整结束时，会保留文件和任务单，重新准备执行上下文；不会直接重放上次未完成的工具调用。仍需经过检查和 Lead 审阅才能算完成。

### Sidekick 一直等待模型，或者同一个错误反复出现

先展开 Sidekick 过程，查看最后一条输出或工具结果。底部“本次已运行”统计的是整个 Run，不能当成这一次模型请求的等待时长。

当前版本会做这些处理：

- 一次模型流式响应达到 `timeout_seconds` 就停止，持续心跳也不能延长时限。默认是 120 秒。
- 同一个工具连续三次返回相同的 Fusion 拒绝错误，会结束这一轮：Sidekick 提交“受阻”报告交给 Lead，Lead 则暂停并显示失败原因；有成功工具结果或新任务时重新计数。
- 命令的停止情况不明时，两模型都会结束本轮并提示核查，不再继续派单或反复补报告。
- 报告提交后立即结束这一轮，直接返回 Lead。Python 代码中的按位 `&` 可以正常检查，真正的后台命令仍会被拒绝。

需要调整等待时间时，在配置文件已有的 `[models.profiles.sidekick]` 表下填写：

```toml
timeout_seconds = 120
max_retries = 1
```

`timeout_seconds` 限制一次流式响应。模型确实需要较长时间才能生成完整代码时，可以增加它；`max_retries = 1` 表示无公开输出的临时故障最多再试一次，设为 `0` 则直接返回失败。重试和多次工具调用都会增加任务总时长。已经显示正文的请求失败后不会自动重放。

Sidekick 的文件工具把 `/` 当作项目根目录；Shell 中的 `/` 则是电脑根目录。命令工具已经从真实工作目录启动，测试应直接用 `python3 -m unittest discover -s tests -v` 等相对项目路径命令。提示中会给出实际目录；显式 `cd /` 或 `find /` 会在执行前被拒绝，避免误扫整台电脑造成长时间等待。

更新代码或配置后，先中断当前执行并正常退出，再重新启动 Harness，让 CLI 和 Python Host 加载新代码。进入原会话用 `/fusion status` 查看任务；若显示“结果不明”，可以直接提问进行只读核查。需要恢复修改时，再按第 5 节确认停止情况。当前卡住的旧进程不会自动加载修复。

### Lead 说自己不能写文件

这是 Fusion 的分工。让它把写文件的任务交给 Sidekick。例如发送：“请把修改工作交给 Sidekick，完成后检查结果。”

### 显示模型鉴权失败、HTTP 401 等错误

先看失败的是 Lead 还是 Sidekick，再按失败消息中的原因处理。界面会显示 HTTP 状态和下一步，例如：

```text
上游账号 cn-cli 的登录已失效（HTTP 401）。
请在代理控制台重新登录，完成授权后回到当前对话继续。
```

这里要重新登录的是代理连接的上游账号。若你的 Lead 代理使用 `8788` 端口，就打开它的控制台，为对应账号重新登录并完成浏览器授权，随后回原会话发送“继续”。Sidekick 失败时，处理 Sidekick 对应的服务。

若提示“当前 API Key 被拒绝”，则检查模型密钥，以及 `api_key_env` 指向的环境变量。403、404、参数错误、超时和限流的处理见[网关请求失败](故障排查.md#网关请求失败)。

### 新文件报 `FUSION_PATH_INVALID`

让 Lead 使用相对于项目目录的路径，例如 `calculator.py`、`tests/test_calculator.py`。目录可以写成 `tests/`。

文件或目录可以由 Sidekick 新建。以 `/` 开头的 `/calculator.py` 不能用于指定允许修改的文件。

如果出现 `FUSION_FIRST_ORDER_REQUIRED`，表示首轮任务单尚未创建，应先用首次派单工具 `fusion_delegate`。返工工具 `fusion_rework` 用于已有任务单的后续修改；它不要求必须已经有审阅票据。

### 检查失败，或者一直显示“等待审阅”

检查失败时，让 Lead 安排 Sidekick 修复后重新检查。“检查通过，等待审阅”表示测试通过了，但 Lead 还没有确认任务完成。

在原对话输入具体反馈，例如：

```text
继续返工：修复空字符串的处理，补充测试，然后重新运行检查。
```

正常情况下会出现新的 Sidekick 轮次，随后是检查和 Lead 审阅。同一任务允许修改的原文件，以及已授权目录中的子文件，返工时都可以继续修改；重复列出这些路径不算扩大权限。需要新增原范围以外的文件时，Lead 应在返工派单中说明原因。文件和命令仍按当前审批模式执行。

### 报 `FUSION_SNAPSHOT_UNAVAILABLE`

检查启动命令的 `--cwd`。如果项目使用 Git，它应指向仓库根目录。也可以先用第 1 节的独立演示目录排查。

Fusion 目前用于本机项目，工作模式选择 Build，审批模式建议选择 default。正在使用 Goal 目标任务或手动选择的 Skill 时，先处理这些任务，再开启 Fusion。远程沙箱暂不支持 Fusion。

其他界面操作见 [交互使用](交互使用.md)，启动报错见 [故障排查](故障排查.md)。

## 8. 让 Sidekick 先调查代码

在已经开启 Fusion 的 Harness 输入框发送：

```text
先让 Sidekick 只读调查这个项目的入口、核心模块和现有测试，给出文件路径依据。
Lead 核实关键结论后，再提出修改方案。调查阶段不要改文件或运行命令。
```

模型会按需要调用 fusion_explore。你会看到独立的 **Sidekick · 模型名 · 只读探索** 过程，里面有读取的文件和调查结论。它不会占用实施轮次，也不能写文件、执行测试或代替验收。模型资源暂忙时，工具会说明原因；Lead 可以先读关键文件或等其他执行结束，不必取消正常任务。

Lead 保留读取能力，用来核实关键文件。简单的一两处读取可能直接完成，不必为每个问题额外派一次调查。真正修改时，仍走“Sidekick 实施 → Harness 检查 → Lead 审阅”。

## 9. 查看两侧用量和金额估算

运行结束后，在 Harness 输入框输入：

```text
/fusion status
```

状态末尾会增加类似内容：

```text
Lead 输入 1200 / 输出 180，缓存 40%；Sidekick 输入 3600 / 输出 600，缓存未知
```

输入/输出是 token 数，不是汉字数。“缓存未知”表示服务没有给出完整缓存统计；“统计不完整”表示至少一次调用缺少用量。这些情况不会按零元计算。

用量在每次执行片段返回、失败或取消后保存，重试也会单独计入；不是逐 token 更新的实时账单。任务恢复后继续累计，重复回执不重复计算。它只统计本功能观测到的调用；升级前历史、摘要模型请求和故障时的只读核查不包含在旧任务用量里。

**默认不显示金额。** 如果需要估算，在可信配置文件中给两个模型分别加单价。下面只演示格式，数字不是模型的真实报价；请按服务商自己的价格填写，单位为“每百万 token”：

```toml
[models.profiles.lead.pricing]
currency = "CNY"
input_per_million = 10
output_per_million = 30
cached_input_per_million = 1

[models.profiles.sidekick.pricing]
currency = "CNY"
input_per_million = 2
output_per_million = 6
cached_input_per_million = 0.2
```

如果你的模型 profile ID 不叫 lead / sidekick，把表名改成实际 ID。修改配置后重新启动，价格对新任务生效；已有任务仍受其冻结配置约束。没配齐两侧同币种单价时只显示 token，不猜价格或汇率；缓存 token 非零却没填缓存单价时，金额显示未知。

金额按“普通输入 × 输入单价 + 缓存输入 × 缓存单价 + 输出 × 输出单价”估算。普通输入是总输入扣除缓存输入。它不包括服务商可能另外收取的缓存写入费、固定费用等。

“假设差额”表示：**Sidekick 这些 token 如果按 Lead 的单价计算，与按 Sidekick 单价计算相差多少。** 它可能为负，不能当成真正跑了一次全 Lead 任务的节省额，也不是实际账单。还要结合任务完成质量和总用量判断是否值得使用 Fusion。

## 10. 调整团队提示和重复失败处理

需要固定团队习惯时，在对应的可信 Fusion 组合表内追加字段，例如：

```toml
[fusion.profiles.default]
lead_profile_id = "lead"
sidekick_profile_id = "sidekick"
lead_prompt_append = "先确认对外接口是否变化，审阅时列出影响。"
sidekick_prompt_append = "报告中列出修改文件、验证结果和未解决问题。"
```

把字段加入已有组合即可，不要在同一 TOML 中重复声明同一表。这些文字需要重启后生效，不能给 Lead 增加写权限，也不能让 Sidekick 越过允许范围。配置和任务状态摘要只标记是否追加，不直接显示这些文字。

连续两轮出现相同未解决事项或相同检查失败时，状态会提示“请换一种实现或检查策略”。它是提醒，不是判定模型一定卡死；不会自动取消任务、扩大权限或跳过检查。Lead 应集中反馈、换方法或向你解释具体缺少的信息。

若想中途纠偏，当前仍先按 Ctrl+C 停止，再发送新要求；结果不明时按第 5、7 节核查。当前没有 /fusion takeover，不支持让 Lead 临时直接写文件，也不会把上一个任务的执行 checkpoint 直接交给下个任务。

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
| `fusion_explore` | Sidekick 只读调查，不改文件、不执行命令。 |
| `fusion_delegate` | Lead 把任务交给 Sidekick。 |
| `fusion_submit_result` | Sidekick 提交这一轮的结果。 |
| `fusion_rework` | Lead 要求 Sidekick 继续修改。 |
| `fusion_review_result` | Lead 提交检查结果；接受后，改代码任务才算完成。 |
