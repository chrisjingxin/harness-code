# HC-181 CLI 安装与分发实施计划

关联：[Task](../task/archive/HC-181-CLI安装与分发.md) · [Spec](../spec/HC-181-CLI安装与分发.md) · [Todo](../todo/HC-181-CLI安装与分发.md)

状态：计划待执行。不新增范围。实现严格 TDD；一次只推进到下一个可演示停点，勾选 Todo、更新 `tmp/handoff.md` 后停下等用户查看。

## 1. 通俗怎么拆

先让已经编出来的 CLI 在仓库外能找到内核，并且 `harness --version` 不再拉起 Python。然后做出两个能本地安装的包。最后用安装脚本把「缺依赖就补齐」串起来，Windows 与文档同一期收口。

```text
停点 A  --version/--help 不启动内核；安装形态按 PATH 找 harness-agent，找不到就失败关闭
  ↓
停点 B  本地 wheel + 界面包可被 uv tool / bun install -g 装出 harness 与 harness-agent
  ↓
停点 C  install.sh：检测并补齐 Bun/uv/Python，装两包，写 PATH，自检
  ↓
停点 D  install.ps1 + Windows 查找 + 用户文档/README/架构；三系统证据
  ↓
review
```

每一停点都是用户能看见的纵向结果，不按 cli/agent/scripts 水平分层硬拆。A 不依赖企业 registry；B 用本地产物；C/D 才对接安装入口与环境变量覆盖。

## 2. 依赖顺序

```text
CLI_VERSION 短路命令
  → runtime-binding（env → harness-agent → 开发 venv → 失败）
      → startAgent 只消费解析结果
          → za38-agent console script
          → @za38/cli 发布形状（dist + OpenTUI 依赖）
              → install.sh / install.ps1
                  → PATH、示例配置、文档
```

不能先写安装脚本再改定位：脚本自检依赖 `--version`，真实启动依赖 `harness-agent`。

## 3. 已锁定做法

- 内核安装形态入口是 `harness-agent` console script，不是给用户 PATH 增加一个完整 Python。
- 生产路径删除对裸 `python3` 的降级。`HARNESS_AGENT_PYTHON` 与开发 `.venv` 保留。
- 开发形态继续设置 `PYTHONPATH` 到 `packages/agent`；安装形态不设这条。
- 界面包用现有 `bun build --target bun` 产物；protocol 打进 `dist`，不要求用户再装 `@za38/protocol`。
- 安装器是 `scripts/install/install.sh` 与 `scripts/install/install.ps1`，语义同一份 Spec 第 5 节。
- 企业 URL 全部可覆盖：`HARNESS_INSTALL_BASE_URL`、`HARNESS_NPM_REGISTRY`、`UV_INDEX_URL`、`HARNESS_BUN_INSTALL_URL`、`HARNESS_UV_INSTALL_URL`。
- 不引入新运行时依赖。安装器只调用 bun/uv 已有官方安装方式。
- 不改 JSON-RPC、TUI、配置 schema。
- 真实企业 CDN 上传可以晚于仓库内脚本与打包命令；本 Task 交付脚本、打包、文档占位与环境变量，不把「已有公网域名」当作代码前置。

## 4. 停点 A：仓库外能找到内核，`--version` 可自检

### 用户结果

在任意目录执行构建出的 CLI：`harness --version` 立即打印版本且没有 Python 进程。设置 PATH 指向夹具里的 `harness-agent` 时，无头命令能 spawn 该可执行文件；去掉它则得到「未找到内核」而不是系统 `python3`。

### 依赖有序任务

| 步骤 | 改什么 | 为什么 | 验证 |
| --- | --- | --- | --- |
| A1 | `parseArgs` / `execute` 增加 version/help，短路不 `startAgent` | 安装器自检不能拉内核 | 先写失败测试：`--version` 不调用 startAgent；`skills install --version` 仍是 Skill 参数 |
| A2 | 抽出 `runtime-binding`，按 Spec 第 6 节顺序解析 argv | 现在相对路径 + 裸 python3 会在仓库外装错 | 夹具覆盖四种顺序与 Windows `.exe` 名称 |
| A3 | `startAgent` 只消费解析结果；安装形态不写开发 `PYTHONPATH` | 避免安装包被源码树污染 | 现有「src/dist 都指向 packages/agent」测试改为开发形态断言，并增加安装形态断言 |

规模：M。可演示：仓库外 `bun <cli> --version`；以及 `HARNESS_AGENT_PYTHON` 指向测试解释器的无头启动（mock/夹具，不连真实模型）。

## 5. 停点 B：两个包能在本机装出来

### 用户结果

在临时 HOME 里：`uv tool install` 本地 wheel 后 PATH 上有 `harness-agent`；`bun install -g` 本地界面包后 PATH 上有 `harness`。`harness --version` 通过；无头 `-n` 能拉起刚装的内核（mock 或立即退出的夹具即可）。

### 依赖有序任务

| 步骤 | 改什么 | 为什么 | 验证 |
| --- | --- | --- | --- |
| B1 | `pyproject.toml` 增加 `harness-agent` script | uv tool 只暴露 console script | wheel 元数据与 `python -m harness_agent` 同入口 |
| B2 | 界面包 `files`/打包脚本：只含 dist 与运行依赖，关闭产物 private | 现在 private + 无 files，不能作为全局包 | 打包清单测试：有 dist/index.js 与 web 资产，无 tests |
| B3 | 用本地产物在隔离 HOME 安装并跑 A 的定位逻辑 | 证明安装形态不是只在源码树里成立 | focused：安装后解析到 `harness-agent`，找不到开发 `.venv` 也不回退 python3 |

规模：M。不访问公网 npm/PyPI；企业索引用本地路径或已有 `UV_INDEX_URL` 的离线 wheel。

## 6. 停点 C：Unix 一条命令

### 用户结果

macOS 或 Linux 上执行 `install.sh`（可用 `HARNESS_*` 指向本地/企业源）。缺的 Bun/uv/Python 被补齐，已有则跳过。结束后 `harness --version` 成功；无配置则出现示例 `config.toml`（0600），已有配置不被改。

### 依赖有序任务

| 步骤 | 改什么 | 为什么 | 验证 |
| --- | --- | --- | --- |
| C1 | `scripts/install/install.sh`：支持矩阵、参数、退出码 | 用户入口 | fixture 测未知参数=2、不支持 arch=1、跳过已有 bun |
| C2 | 调用 bun/uv 官方或覆盖 URL；装两个包；写 PATH；跑 `--version` | Spec 第 5.2 步 | 失败下载不报成功；`--no-modify-path` 仍能自检 |
| C3 | 示例配置复制规则 | Task：可放示例、不写密钥 | 已有文件不覆盖；新文件无字面量密钥 |

规模：M。演示在 macOS 或 Linux 开发机上对脚本走一遍；可用本机已有 Bun 验证「跳过运行时、仍装/对齐包」的路径。

## 7. 停点 D：Windows 与文档收口

### 用户结果

PowerShell 一条 `install.ps1` 与 Unix 语义相同。CMD 运行时得到「请用 PowerShell」而不是半安装。README / 快速开始 / 故障排查写清三系统命令、手动包管理器安装、卸载、PATH 未生效、不支持架构。架构总览补「安装启动」路径。

### 依赖有序任务

| 步骤 | 改什么 | 为什么 | 验证 |
| --- | --- | --- | --- |
| D1 | `scripts/install/install.ps1` 与 C 同一语义 | 三系统同一期 | 宿主不是 PowerShell 时退出 1；PATH 写用户级 |
| D2 | Windows 可执行文件名在 binding 与脚本中一致 | 现有代码只降级 `python3` | focused 覆盖 `.exe` |
| D3 | 用户文档、README、架构总览；去掉「只能从源码运行」 | Task 验收 8 | `docs:check`；按文档做一次对照 |

规模：M。Windows x64 至少一次真实安装证据（或 CI Windows runner）；TUI 进主界面在有 TTY 的机器上看一次，无头握手可作 CI 证据。musl / Windows ARM 若无构建，文档与脚本拒绝文案必须存在。

## 8. 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 企业 registry 尚未有可写地址 | 无法做公网 curl 演示 | 脚本与文档用环境变量；本地 registry/file 验证行为 |
| OpenTUI native 未镜像到目标平台 | TUI 起不来 | 安装器不支持该平台时拒绝；必过矩阵不含无包平台 |
| `sqlite-vec` 等无 Windows ARM wheel | ARM 机器装完崩溃 | 无 wheel 则拒绝，不把 ARM 算 Windows 已交付 |
| 已有 Bun 1.3+ 与 OpenTUI 0.4.3 不兼容 | 跳过安装后 TUI 失败 | 自检至少保证能执行 JS；若 `--version` 过但 TUI 因 FFI 失败，在故障排查写明改用 1.2.19 |
| 安装器给用户装了 Bun/uv | 改变用户机器全局工具 | Task 已确认「没有就帮装」；卸载不反向删除它们 |

## 9. 验证命令（实现时按停点跑子集）

```bash
rtk bun test packages/cli/tests/index.test.ts
rtk bun test packages/cli/tests/args.test.ts
# 停点 A/B 增加的 focused 测试目录以实现为准
rtk cd packages/agent && .venv/bin/python -m pytest -q tests/test_main.py
rtk bun run typecheck
rtk bun run docs:check
```

全 Task 交付前再跑 `rtk bun run project:check`、`rtk bun run typecheck`、相关 focused tests。Sandbox 内不能做的真实 Windows 安装写入证据并标明跳过原因，不得当成代码缺陷。
