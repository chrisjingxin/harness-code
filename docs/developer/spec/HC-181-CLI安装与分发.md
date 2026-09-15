# HC-181 CLI 安装与分发规格

关联任务：[HC-181](../task/archive/HC-181-CLI安装与分发.md)  
调研：[181-CLI安装与分发方案.md](../research/181-CLI安装与分发方案.md)  
架构入口：[架构总览](../architecture/架构总览.md)

用户结果与验收以 Task 为准。本文规定行为、公开 interface、错误语义和 invariant。不规定实施步骤。Plan / Todo 必须与本文同名，不得把 Task 非范围做成范围。

## 1. 通俗目标

现在只有开发者能用 Harness：克隆仓库，准备 Bun 和 Python，在仓库根目录执行 `bun run dev`。装完后，普通用户抄一条命令，缺的工具由脚本补上，然后在任意项目目录输入 `harness`，看到现在这套交互界面。

```text
用户执行安装命令
  → 识别操作系统和架构（不支持则立刻失败）
  → 检查 Bun、Python 3.11+、uv；缺了就安装
  → 从企业源安装界面包和内核包
  → 把 harness 放进 PATH，并用 harness --version 确认成功
  → 用户进入项目目录输入 harness → 现有 TUI
```

界面仍由 Bun 运行，内核仍由 Python 运行。安装器只负责把两块装好并让它们互相找到。不改对话、审批、协议或模型配置语义。

## 2. 已确认决策

来自已确认 Task，Spec 不得改写：

1. macOS、Linux、Windows 同一期交付；Windows 用 PowerShell 脚本，不用 `curl | bash`。
2. 实现走包管理器：`bun install -g` 装界面，`uv tool install` 装内核。不打自包含运行时大包。
3. 缺 Bun / Python 3.11+ / uv 就帮用户装；已合格不重复装。
4. 主路径不是 Node 的 `npm install -g`。文档可附手动 `bun install -g` 与 `uv tool install`。
5. 对外命令名是 `harness`。`za38` 可作为同一可执行文件的别名，不作宣传名。
6. 工作区仍是用户当前目录。配置仍是用户级 `~/.harness/config.toml`（Windows 为 `%USERPROFILE%\.harness\config.toml`）。
7. 包源与安装器下载地址必须能用环境变量指到企业镜像。
8. 仓库内 `bun run dev` 继续给开发者用。
9. 安装器不写入 API Key。已有配置文件不覆盖。
10. Alpine/musl 与 Windows ARM 不是第一验收平台；没有对应构建时安装器必须拒绝并说明。必过：macOS Intel 与 Apple Silicon、Linux glibc x64/arm64、Windows x64。

本 Spec 补齐的实现口径：

11. 安装形态下内核入口是 PATH 上的 `harness-agent`（uv tool 的 console script），不是系统 `python3 -m harness_agent`。
12. 生产安装找不到内核时失败关闭，不得静默落到未安装 `harness_agent` 的系统 Python。
13. `harness --version` 与 `harness --help` 不启动 sidecar、不读配置、不打开 SQLite。
14. 企业实际公网/内网 URL 可以是占位符；行为由环境变量覆盖，不把某个公网域名写成唯一入口。

## 3. 术语

```text
界面包
└─ 发布后的 @za38/cli。提供 harness / za38 命令和 TUI。

内核包
└─ 发布后的 za38-agent。提供 harness-agent 命令，内部仍是 python -m harness_agent。

安装器
└─ install.sh（macOS/Linux）与 install.ps1（Windows）。检测依赖、补齐、装两个包、写 PATH、自检。

开发形态
└─ 仓库内 bun run dev / bun packages/cli/src/index.ts，继续用 packages/agent/.venv。

安装形态
└─ 用户 PATH 上的 harness 启动已安装界面包，再拉起已安装内核包。
```

## 4. 模块与 seam

一项功能只维护本文这一份 Spec。下表是内部模块边界，不是平行文档树。

| 模块 | 职责 | 调用方必须知道的 interface | 依赖 |
| --- | --- | --- | --- |
| `cli-version` | 解析并执行 `--version` / `--help` | 不启动 sidecar；stdout 只有版本或用法 | 现有 `CLI_VERSION` |
| `runtime-binding` | 决定启动哪个内核进程 | 输入 env、PATH、CLI 模块目录；输出可 spawn 的 argv 与是否注入开发用 `PYTHONPATH` | 无 |
| `package-artifacts` | 界面包与内核包的可安装形状 | `bun install -g @za38/cli` 得到 `harness`；`uv tool install za38-agent` 得到 `harness-agent` | 现有 dist 构建与 uv 构建 |
| `install-scripts` | 三系统安装入口 | 一条命令：检测 → 补齐依赖 → 装两包 → PATH → `harness --version` | 上两行 |

深度要求：`runtime-binding` 对外是一个解析函数。调用方（`startAgent`）只拿到 argv/env，不理解 uv tool 目录、Windows `Scripts`、源码相对路径。测试只打这一层，不在每个命令里复制查找逻辑。

## 5. 用户安装 interface

### 5.1 命令

macOS / Linux：

```bash
curl -fsSL https://<企业安装入口>/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://<企业安装入口>/install.ps1 | iex
```

用户不必先设环境变量。仓库脚本顶部的 `DEFAULT_*` 为空，托管前必须改成真实企业安装入口、npm、PyPI。环境变量只作覆盖。不要把示例域名写进仓库。

安装器支持：

| 参数 / 环境变量 | 作用 |
| --- | --- |
| `--version <SemVer>` / `HARNESS_INSTALL_VERSION` | 安装指定界面包与内核包版本；默认 `latest` |
| `--no-modify-path` / `HARNESS_NO_MODIFY_PATH=1` | 不改 shell rc / Windows 用户 PATH |
| `--help` | 打印用法后退出 0 |
| `HARNESS_INSTALL_BASE_URL` | 覆盖脚本顶部 `DEFAULT_INSTALL_BASE_URL` |
| `HARNESS_NPM_REGISTRY` | 覆盖脚本顶部 `DEFAULT_NPM_REGISTRY` |
| `UV_INDEX_URL` | 覆盖脚本顶部 `DEFAULT_PYPI_INDEX` |
| `HARNESS_BUN_INSTALL_URL` | 覆盖 Bun 官方安装脚本 |
| `HARNESS_UV_INSTALL_URL` | 覆盖 uv 官方安装脚本 |
| `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` | 下载时尊重代理 |

未列出的参数视为未知，退出码 2，并打印用法。

### 5.2 安装步骤（两脚本同一语义）

```text
不支持的 OS/架构 → 退出 1，说明当前系统与必过矩阵
已有合格 Bun（≥1.2.19）→ 跳过；否则按 HARNESS_BUN_INSTALL_URL 或默认官方脚本安装 1.2.19
已有 uv → 跳过；否则安装 uv
uv 能提供 Python ≥3.11,<4.0 → 跳过系统 Python 安装；否则 `uv python install` 3.12
bun install -g @za38/cli@<version>（企业 registry）
uv tool install za38-agent==<version>（企业索引，使用 3.11+ Python）
将 bun 全局 bin 与 uv tool bin 加入 PATH（除非 --no-modify-path）
优先 symlink/复制到已在 PATH 且可写的用户 bin，使当前终端尽量立刻可用
执行 harness --version；失败则退出 1，不得报告安装成功
用户配置文件不存在时复制示例到 ~/.harness/config.toml（权限 0600），并提示设置密钥；已存在则不动
```

Windows 检测自己跑在 CMD/Git Bash 时，打印「请在 PowerShell 中运行」并退出 1，不继续半安装。

### 5.3 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 安装成功，`harness --version` 已通过 |
| 1 | 系统不支持、下载失败、依赖安装失败、包安装失败、自检失败、错误的宿主 shell |
| 2 | 未知参数或用法错误 |

成功时 stdout 简短说明：装到了哪里、如何启动、若 PATH 未立刻生效要新开终端。密钥提示不得复述密钥值。

### 5.4 手动安装（文档附加，不是第二条主路径）

已有 Bun 与 uv 的用户可以：

```bash
bun install -g @za38/cli --registry <企业 npm>
uv tool install za38-agent --index <企业索引>
```

效果与安装器装包步骤相同，但不自动补齐 Bun/uv/Python、不改 PATH、不复制示例配置。

### 5.5 卸载

文档说明：

```bash
bun remove -g @za38/cli
uv tool uninstall za38-agent
```

不卸载用户本机的 Bun、uv、Python，不删除 `~/.harness/config.toml` 与日志。PATH 片段可手工删。安装器第一期不提供 `uninstall.sh` 文件，除非实现时发现 Windows 用户 PATH 清理离开脚本无法完成；若增加卸载脚本，行为仍仅移除两个包和本安装器写入的 PATH 片段。

## 6. 运行时定位 interface

`startAgent` 只调用 `runtime-binding` 的解析结果来 `spawn`。查找顺序：

1. `HARNESS_AGENT_PYTHON` 非空：把它当作 Python 解释器，argv 为 `[python, "-m", "harness_agent"]`。这是开发与排障覆盖，不在安装器里设置。
2. PATH 上能解析到 `harness-agent`（Windows 为 `harness-agent.exe`）：argv 为 `[该可执行文件]`，不附加 `-m`，不设置开发用 `PYTHONPATH`。
3. 现有开发探测：CLI 模块目录相对的 `packages/agent/.venv/bin/python` 或 `Scripts/python.exe`，且该解释器能用于 `-m harness_agent`。仅开发形态使用，并继续把 `PYTHONPATH` 指向源码 `packages/agent`。
4. 否则抛出明确错误：未找到 Harness 内核，请运行安装器或设置 `HARNESS_AGENT_PYTHON`。**禁止**再落到 PATH 上的 `python3` / `python`。

`spawn` 的 `cwd` 仍是用户工作区。`HARNESS_COMMAND_KIND`、沙箱覆盖、配置路径环境变量保持现有语义。

`harness logs` 继续在定位内核之前短路，不启动 sidecar。`--version` / `--help` 同样短路。

工作区校验（目录必须存在）发生在启动 sidecar 的命令上，不发生在 `--version` / `--help`。

## 7. CLI 公开命令增量

在现有 `parseArgs` 命令联合上增加：

```text
harness --version
harness -V
harness --help
harness -h
```

- `--version` / `-V`：stdout 一行，内容为当前 `CLI_VERSION`（与 `VERSION` / 发布版本一致），退出 0。
- `--help` / `-h`：stdout 打印用法，包括交互启动、无头 `-n`/`-m`、`logs`、`config`、`skills`、`plugins`，以及「安装后直接运行 harness」。退出 0。
- 它们出现在 argv 任意位置且没有其它子命令时生效；`skills install --version` 仍是 Skill 包版本，不是 CLI 版本。
- 这两个命令不是 JSON-RPC 方法，不握手。

`bin` 字段继续提供 `harness` 与 `za38`，指向同一 `dist/index.js`。shebang 保持 `#!/usr/bin/env bun`。

## 8. 包发布形状

### 8.1 内核包 `za38-agent`

- 现有 `pyproject.toml` 名称与锁定依赖不变。
- 增加 console script：`harness-agent = "harness_agent.__main__:main"`，行为与 `python -m harness_agent` 相同。
- `uv build` 产出 wheel；`uv tool install` 只把 `harness-agent` 放到 uv tool bin，不把完整 Python 放进用户 PATH。
- 不把 pytest extra 打进默认安装。

### 8.2 界面包 `@za38/cli`

- 发布物包含 `dist/`（`index.js`、语法 WASM/scm、`web-assets.json` 与 Web 静态资源）和运行所需的 OpenTUI/React 依赖。
- `@za38/protocol` 已由当前 `bun build` 打进 `dist/index.js`，不必作为用户机器上的独立安装步骤。若打包脚本选择同时发布 protocol 包，不能要求用户再装一次才能运行 `harness`。
- OpenTUI native optional package 由 bun 按平台解析；企业 registry 必须能提供当前平台的 `@opentui/core-<os>-<arch>@0.4.3`。
- 源码仓库可保持 `"private": true`；打包脚本生成可发布副本（关闭 private、写入 `files`）。禁止把测试、`.venv`、源码树 `node_modules` 整包打进发布物。

### 8.3 版本

界面包、内核包、`CLI_VERSION`、根 `VERSION` 必须同一 SemVer。安装器 `--version` 同时钉死两个包。只发其中一个视为发布失败。

## 9. PATH、配置与权限

- Unix：bun 全局 bin 通常为 `~/.bun/bin`；uv tool bin 通常为 `~/.local/bin`。二者都要在 PATH 中，否则 `harness` 起得来、内核找不到，或反过来。
- Windows：写入用户级 PATH（不是系统级），包含 bun 全局 bin 与 uv tool bin（通常 `%USERPROFILE%\.bun\bin` 与 `%USERPROFILE%\.local\bin`）。
- 若某用户 bin 已在 PATH 且可写，安装器可把 `harness` 与 `harness-agent` 链过去，让当前窗口立刻可用；失败只警告，不以它代替 rc/用户 PATH 写入。
- `--no-modify-path` 时打印需要加入 PATH 的目录，退出码仍由自检决定；自检可对脚本进程临时注入 PATH。
- 示例配置来自仓库 `docs/user/examples/config.toml`，安装器或界面包内携带同一份副本。只在目标文件不存在时写入，权限 `0600`（Windows 不把 POSIX mode 当 ACL 保证，但不得把文件写成 Everyone 可写）。
- 提示用语沿用现有配置文档：推荐 `HARNESS_API_KEY` 环境变量。

## 10. 错误语义

| 情况 | 行为 |
| --- | --- |
| 不支持的 OS/架构 | 安装器退出 1，打印当前系统与支持矩阵 |
| Windows 在 CMD/Git Bash 跑 `irm \| iex` | 退出 1，告诉用户打开 PowerShell |
| 下载或企业源不可达 | 退出 1，保留已有 Harness 安装；不把失败包标成成功 |
| `harness --version` 自检失败 | 退出 1，说明界面包未正确进入 PATH 或 Bun 无法执行 |
| 安装形态找不到 `harness-agent` | CLI 启动 sidecar 时失败，错误要求运行安装器或设置 `HARNESS_AGENT_PYTHON`，不启动 TUI |
| `HARNESS_AGENT_PYTHON` 指向无效解释器 | spawn 失败，错误包含该路径，不回退系统 Python |
| 交互模式 stdin/stdout 不是 TTY | 保持现有「需要真实终端 / 使用 -n」错误 |
| 工作区不是目录 | 保持现有工作区错误；发生在启动 sidecar 的命令 |
| 配置缺失或无效 | 保持现有配置错误；安装器放入的示例仍可能缺密钥，启动时按现有语义报 `api_key_source=missing`，不得假装已登录 |
| 内核进程非 0 退出 | 保持现有 agentExit 行为 |

不得把企业 registry 地址、完整代理 URL 中的用户名密码、API Key 写进日志或安装器输出。

## 11. 平台矩阵

| 平台 | 本 Task 验收 |
| --- | --- |
| macOS arm64 / x64 | 必过 |
| Linux glibc x64 / arm64 | 必过 |
| Windows x64 | 必过 |
| Linux musl | 无构建则拒绝并说明 |
| Windows arm64 | 无 OpenTUI native 或 Python wheel 则拒绝并说明 |

「必过」指：安装器在该平台跑完、`harness --version` 成功、在真实 TTY 下 `harness` 能进入现有 TUI（或无头 `-n` 能拉起内核）。无头可在 CI 验证内核握手；TUI 以开发机或人工一次为准，并在 Task 证据中写明。

## 12. 测试策略

- CLI：`packages/cli/tests/index.test.ts` 及新建 focused 测试覆盖 `runtime-binding` 顺序、失败关闭、`--version`/`--help` 不调用 `startAgent`。用临时目录夹具模拟 `harness-agent` 可执行文件和开发 `.venv`，不连真实模型。
- 内核：console script 入口测试，断言与 `__main__` 同一 `main()`。
- 安装器：对 `install.sh` / `install.ps1` 的纯函数级步骤用 fixture（假 bun/uv、假 registry、假 `--version`）覆盖支持矩阵、跳过已有依赖、PATH 写入、失败不报成功。不在单元测试里打真实公网。
- 发布形状：打包后的 tarball/wheel 文件清单测试（含 `dist/index.js`、web 资产、不含 tests）。
- 禁止测试使用真实网关密钥。

## 13. 非范围

- 自包含 tarball、嵌入私有 Bun/CPython 目录作为主安装路径。
- 应用内 `/update`、后台自更新、Homebrew、Node npm 全局主路径。
- 安装时浏览器 OAuth、代填 API Key。
- 重写 Agent、改 JSON-RPC v3、改 TUI/Web 交互。
- 改变 `bun run dev`。
- 以 musl 或 Windows ARM 冒充「Linux/Windows 已交付」。

## 14. 成功标准

与 Task 验收一一对应，并可在 Spec 层观察：

1. 三系统各一条安装命令能在未克隆本仓库的机器上装完。
2. 缺 Bun/Python/uv 会补齐；三项合格则跳过运行时安装，仍安装或升级两个 Harness 包。
3. 装完 `harness` 在任意已有目录进入现有 TUI；非 TTY 仍拒绝交互并提示 `-n`。
4. `harness --version` 与发布版本一致；安装器成功判定依赖它。
5. 离开仓库后走 `harness-agent` 或 `HARNESS_AGENT_PYTHON`，不找 `packages/agent/.venv`，不找裸 `python3`。
6. 已有 `config.toml` 不被覆盖；缺失时最多写示例并提示密钥，输出与日志无密钥。
7. 错误宿主 shell 与不支持架构得到可理解失败。
8. README 与快速开始不再把「只能从源码运行」写成现状。
