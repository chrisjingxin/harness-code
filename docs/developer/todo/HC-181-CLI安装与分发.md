# HC-181 CLI 安装与分发执行清单

关联：[Task](../task/archive/HC-181-CLI安装与分发.md) · [Spec](../spec/HC-181-CLI安装与分发.md) · [Plan](../plan/HC-181-CLI安装与分发.md)

状态：已完成并归档。所有 checkbox 仅在动作和验证完成后勾选。每次只推进到下一个可演示停点；不得为勾完清单一次做完整份。行为变更先写最小失败测试，再写最小实现。

## 执行前

- [x] 读取 Task/Spec/Plan 与 `git status --short`；保留用户已有改动，不回滚无关文件。完成信号：handoff 写明基线。
- [x] 认领：`bun run task:claim -- HC-181 --owner Grok --branch feat_hc_181_CLI安装与分发`。完成信号：Task 为进行中且有分支。
- [x] 使用 `test-driven-development`；禁止真实网关密钥和把用户 `~/.harness/config.toml` 当测试夹具。完成信号：测试只用临时 HOME / 夹具目录。

---

## 停点 A：`--version` 可自检，仓库外能找到内核

用户怎么看：

```bash
bun packages/cli/src/index.ts --version
bun packages/cli/src/index.ts --help
```

`--version` 立刻打印与 `VERSION` 一致的一行，不启动 Python。再在临时目录把一个假 `harness-agent` 放进 PATH，无头命令应 spawn 它；拿走后应报未找到内核，而不是去调系统 `python3`。

### A1 `--version` / `--help` 短路

- [x] 先写失败测试：`parseArgs(["--version"])` 得到 version 命令；`execute` 不调用 `startAgent`；stdout 为 `CLI_VERSION`。`skills install --version` 仍是 Skill 参数。完成信号：未实现前测试失败。
- [x] 实现 version/help 命令与 `execute` 短路，用法包含交互启动与无头 `-n`。完成信号：`cd packages/cli && bun test tests/args.test.ts tests/index.test.ts` 中相关用例通过。

### A2 runtime-binding

- [x] 先写失败测试覆盖 Spec 第 6 节顺序：`HARNESS_AGENT_PYTHON` → PATH `harness-agent` / `harness-agent.exe` → 开发 `.venv` → 明确失败。断言不再出现裸 `python3`/`python` 降级。完成信号：未改定位前，现有「落到 python3」行为使新测试失败。
- [x] 实现单一解析函数，返回 argv 与是否注入开发 `PYTHONPATH`。完成信号：夹具四种路径均符合 Spec。

### A3 接入 startAgent

- [x] 改 `startAgent` 只消费解析结果；安装形态不设置源码 `PYTHONPATH`。保留现有工作区校验与 sidecar stderr drain。完成信号：开发形态测试仍解析到 `packages/agent`；安装形态测试不碰该目录。
- [x] 更新「源码与 dist 都解析到 packages/agent」测试，使其只描述开发形态。完成信号：旧断言不再强迫安装形态走源码树。

### 停点 A 验证与交接

- [x] `cd packages/cli && bun test tests/args.test.ts tests/index.test.ts` 及本停点新 focused 测试通过。
- [x] 按本节演示命令查看 `--version` / `--help`；用夹具 PATH 验证内核查找。
- [x] 更新勾选与 `tmp/handoff.md`，**停下等用户查看，未经要求不做 B**。

---

## 停点 B：本地能装出两个命令

用户怎么看：在临时 HOME 中安装本地 wheel 与本地界面包后：

```bash
harness --version
harness-agent --help   # 或启动后立即被测试关掉；至少进程能起来
```

PATH 上同时有 `harness` 与 `harness-agent`，且 CLI 解析到后者。

### B1 内核 console script

- [x] 先写失败测试：安装/entry 能调用 `harness_agent.__main__:main`。完成信号：未实现前测试失败。
- [x] `pyproject.toml` 增加 `harness-agent` script，行为与 `python -m harness_agent` 相同。完成信号：`packages/agent/tests/test_harness_agent_entry.py` 通过；wheel 含同一 entry point。

### B2 界面包发布形状

- [x] 先写失败测试：打包产物含 `dist/index.js`、web 资产，不含 `tests/`。完成信号：未实现前测试失败。
- [x] 增加打包脚本（生成可发布副本：关闭 private、写入 files、只带 dist 与声明依赖，去掉 workspace protocol）。完成信号：本地 pack 后清单符合 Spec 8.2。

### B3 隔离 HOME 安装

- [x] 用隔离 prefix 安装本地 wheel，断言 PATH 解析到 `harness-agent` 且不走开发 `.venv`。tarball 形状已验证；`bun install -g` 仍需企业 registry 拉 OpenTUI，留到停点 C 的安装脚本对接。完成信号：无开发 `.venv` 时仍找到 `harness-agent`，不会落到系统 Python。

### 停点 B 验证与交接

- [x] 内核与 CLI focused tests、打包清单测试通过。
- [x] 在隔离目录演示 wheel 脚本与 CLI tarball。
- [x] 更新勾选与 `tmp/handoff.md`，**停下等用户查看，未经要求不做 C**。

---

## 停点 C：macOS / Linux 安装脚本

用户怎么看：

```bash
HARNESS_NPM_REGISTRY=<企业或本地> UV_INDEX_URL=<企业或本地> \
  bash scripts/install/install.sh
harness --version
```

缺 Bun/uv/合格 Python 时脚本会装；已有则跳过运行时。无 `~/.harness/config.toml` 时出现示例（无密钥）；已有文件内容不变。

### C1 脚本骨架与失败语义

- [x] 先写 fixture 测试：未知参数退出 2；不支持的 arch 退出 1；`--help` 退出 0。完成信号：无脚本或语义不对时失败。
- [x] 实现 `scripts/install/install.sh` 的参数、支持矩阵、退出码。完成信号：上述 fixture 通过。

### C2 依赖补齐、装包、PATH、自检

- [x] 实现「缺则装、有则跳过」Bun/uv/`uv python`；`bun install -g` 与 `uv tool install`；写入 PATH；调用 `harness --version`。覆盖 URL 环境变量。完成信号：假 bun 已存在时不重复下载；自检失败退出 1 且不打印成功。
- [x] `--no-modify-path` 不改 rc，但进程内仍能自检。完成信号：对应 fixture 通过。

### C3 示例配置

- [x] 目标不存在则复制示例为 `0600`；已存在则不写。完成信号：测试文件无未注释 API Key 字面量；第二次运行不改已有文件。

### 停点 C 验证与交接

- [x] 安装器 fixture 测试通过。
- [x] 在 macOS 上 `bash scripts/install/install.sh --help` 可演示；完整装包仍需企业 registry，由 fixture 覆盖成功/失败路径。
- [x] 更新勾选与 `tmp/handoff.md`，**停下等用户查看，未经要求不做 D**。

---

## 停点 D：Windows 与文档

用户怎么看：PowerShell 中

```powershell
irm <企业>/install.ps1 | iex
harness
```

进入现有 TUI。在 CMD 里跑应得到「请用 PowerShell」。文档给出三系统命令、手动安装、卸载和常见失败。

### D1 install.ps1

- [x] 先写失败测试/fixture：非 PowerShell 宿主退出 1；未知参数退出 2。完成信号：无脚本时失败。
- [x] 实现与 C 同一语义的 `scripts/install/install.ps1`（用户 PATH、覆盖 URL、自检、示例配置）。完成信号：脚本契约测试通过；本机无 pwsh 时不假装跑过 PowerShell 行为测试。

### D2 Windows 可执行文件

- [x] 确认 binding 解析 `harness-agent.exe`；安装器 PATH 包含 uv tool bin 与 bun bin。完成信号：Windows 夹具测试通过（可在非 Windows 上测路径拼接）。

### D3 文档与架构

- [x] 更新 `README.md`、`docs/user/快速开始.md`、`docs/user/故障排查.md`：安装、手动包管理器、卸载、PATH、不支持架构、CMD 误用。删除「只能从源码运行」作为现状的表述；源码开发仍另节保留。
- [x] 架构总览增加安装形态启动路径（`harness` → `harness-agent`）。完成信号：`bun run docs:check` 通过。

### 停点 D 验证与交接

- [x] Unix + Windows 安装器测试、CLI/Agent focused、`docs:check` 通过。
- [x] Windows x64 至少一次安装证据（真实机器或 CI）；无 TTY 的环境用无头握手，TUI 在有终端的机器上看一次。**本环境无 Windows runner、无 pwsh；按用户要求归档，真机安装留到企业源发布后补。**
- [x] musl / Windows ARM 若无构建，脚本拒绝文案与文档已写。
- [x] 更新勾选与 `tmp/handoff.md`，**停下等待用户验收，不自动提交或发布到企业 CDN**。

### 完成与归档（仅全部停点通过后）

- [x] 使用 `code-review-and-quality` 对照 Task/Spec 复查 diff、测试与文档。**用户明确跳过 review。**
- [x] 记录版本影响（无版本变更也要说明）；`bun run typecheck` 与相关 focused tests 通过。
- [x] `bun run task:complete -- HC-181 --evidence "<命令与结果>"`。

---

## 冻结的非范围

- 不打自包含 tarball，不嵌入私有 Bun/CPython 作为主路径。
- 不做应用内 `/update`、Homebrew、Node `npm install -g` 主路径。
- 不代填或写入 API Key，不覆盖已有 `config.toml`。
- 不改 JSON-RPC、TUI 交互、模型配置语义、`bun run dev`。
- 不把 musl 或 Windows ARM 无构建平台算作已交付。
- 发现需要改变公开行为或范围时，回写 Task/Spec/Plan，不得在执行中发明新设计。
