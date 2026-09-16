# CodeGraph 1.1.6 集成评估

评估日期：2026-09-15。Harness 基线：`8f057d4`。

本次判断固定以本地 CodeGraph tag `v1.1.6` 为准：commit `da72946d25e112f662f5a60c6b69f363aec60f16`，提交时间 `2026-06-30T04:42:36+00:00`。源码位置：`/Users/zhangjingxin/Code/OpenSource/codegraph`。

本文是源码调研，不是 Task、Spec、Plan 或开发授权。企业镜像中的实际 tarball、目标机器和权限策略尚未验收，不能把上游源码结论当成企业包已经可用的证明。

## 1. 结论

可以基于 1.1.6 集成，但形态应是：TS/Bun 负责 `/code-index` 交互，Python AgentHost 负责生命周期，CodeGraph 在匹配平台包自带的 Node 子进程中运行。TypeScript 不是障碍；不建议把 SDK 直接 import 到 Harness 的 Bun TUI 进程。

1.1.6 是“主包 + 精确版本绑定的平台包”的发行物。主包提供启动器、SDK shim 和类型声明，平台包提供官方 Node、编译后的 JS、生产依赖和语法资源。1.1.6 的 bundle 脚本没有后续版本的 Rust `.node` 提取内核。[主包 manifest](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/package.json#L1-L55) [npm 打包脚本](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/pack-npm.sh#L3-L17)

推荐边界：

```text
TS/Bun TUI 的 /code-index
    → 现有 IPC / Python AgentHost
    → 随包 Node 子进程
        ├─ init / sync / 全量 index / status
        └─ serve --mcp 的持久 stdio 查询进程
    → 当前 workspace/.harness-index/
```

索引是确定性本地任务，不应由模型决定命令；CodeGraph 只负责定位和上下文，编辑前仍必须执行 Harness 自己的 Snapshot 读取。

1.1.6 的 `CODEGRAPH_DIR` 可以把默认数据目录改名为 `.harness-index`，但只接受工作区根目录下的单个路径段：包含 `/`、`\\`、`..` 或绝对路径时会回退到 `.codegraph`，因此不修改上游时无法使用 `.harness/index`。上游初始化会递归创建数据目录，卸载时也会递归删除它，所以不能把 `CODEGRAPH_DIR` 直接设为还容纳其他 Harness 数据的 `.harness`。Harness 可在初始化前为 `.harness-index` 写入自己的中性 `.gitignore`；1.1.6 检测到非自身模板的已有文件时会保留，不会改写。[目录名校验](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/directory.ts#L12-L57) [创建、保留 ignore 与删除](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/directory.ts#L423-L491)

## 2. npm 发布形状、版本绑定与平台

`v1.1.6/package.json` 的版本是 `1.1.6`，入口是 `dist/index.js`，bin 是 `dist/bin/codegraph.js`，manifest engines 为 Node `>=20.0.0 <25.0.0`，依赖是 JS/WASM 依赖（含 `web-tree-sitter`、`tree-sitter-wasms`）。[manifest](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/package.json#L1-L55)

`scripts/pack-npm.sh` 为平台包写入精确的 `version`、`os`、`cpu` 和文件列表，并为主包写入 exact optional dependencies。因此企业不能只安装主包，也不能把主包 1.6.0 与平台包 1.1.6 混配。[平台包 manifest](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/pack-npm.sh#L29-L72) [主包版本绑定](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/pack-npm.sh#L74-L118)

上游 1.1.6 构建目标为：

| 目标 | 包名（均须为 1.1.6） |
| --- | --- |
| macOS ARM/x64 | `@colbymchenry/codegraph-darwin-arm64` / `...-darwin-x64` |
| Linux x64/ARM64 | `@colbymchenry/codegraph-linux-x64` / `...-linux-arm64` |
| Windows x64/ARM64 | `@colbymchenry/codegraph-win32-x64` / `...-win32-arm64` |

这些是构建目标，不是企业验收承诺；Linux musl、旧版发行版和 Harness 不支持的 Windows ARM 要单独排除或验证。[1.1.6 targets](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/build-bundle.sh#L3-L20)

平台 bundle 包含 `dist`、锁定的生产依赖、官方 Node runtime 和 launcher，并执行 `npm ci --omit=dev --ignore-scripts`；脚本没有复制 Rust kernel。后续 v1.6.0 才出现 `release/kernel/<target>/codegraph-kernel.node`，不能倒推 1.1.6 有 native addon。[1.1.6 bundle](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/build-bundle.sh#L23-L105) [后续 kernel 步骤](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/scripts/build-bundle.sh#L71-L89)

## 3. SDK、Node/Bun 和 TS 集成

1.1.6 的 `npm-sdk.js` 通过匹配平台包加载 `lib/dist/index.js`；打开图数据库使用 `node:sqlite`，SDK 入口要求 Node `>=22.5`。这高于 manifest 的安装过滤条件；平台 bundle 默认 Node 24.16.0，Harness 不应依赖用户系统 Node。[SDK 入口](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/npm-sdk.js#L3-L24) [平台库解析](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/npm-sdk.js#L30-L63) [bundle Node](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/build-bundle.sh#L3-L20)

1.1.6 没有 Bun 兼容性声明，且 SDK 是 CJS shim + `node:sqlite` + 随包 Node。推荐：

- TS/Bun 只做命令、进度和错误展示，不直接 import SDK。
- Python AgentHost 启动、监督、超时、取消、回收 Node 子进程。
- 子进程使用平台包的 `node`/`node.exe` 和固定安装位置的 CLI 或薄 adapter；adapter 只把 `onProgress` 转为 JSONL，不复制解析器、schema 或索引算法。

所以回答“是否集成在 TS 端”：交互可以集成在 TS 端；CodeGraph 执行应留在自己的 Node 边界内。

## 4. CLI/SDK 能力与 Harness 映射

1.1.6 有 `init`、`index`、`sync`、`status`，没有名为 `rebuild` 的 CLI。`init` 初始化后立即 `indexAll`；`index` 的语义是从头重建；`sync` 打开已有图做增量同步。[CLI help/init](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L1-L22) [init](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L468-L544) [index](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L610-L693) [sync](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L699-L755) [status](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L761-L832)

| Harness 行为 | 1.1.6 底层 | 产品决定 |
| --- | --- | --- |
| 首次 `/code-index` | `CodeGraph.init` + 全量 `indexAll` | preflight 后建立图，成功前不可查询 |
| 已有索引 | `open` + `sync()` | 默认增量同步 |
| `status` | JSON 含根目录、版本、统计、DB size、backend、journal、pending changes | 消费 `status --json` 或薄 adapter |
| `rebuild` | 无同名命令；CLI `index` 调 `recreate` 再 `indexAll` | 保留用户友好名称，底层映射到 `index`/`recreate` |
| cancel | SDK `indexAll` 有 `AbortSignal`；CLI 和 `sync` 无取消参数 | Host 终止子进程，结果标为 cancelled/incomplete |

SDK 公开入口还包括 `open`、`recreate`、`close`、`watch`；`destroy()` 只是关闭连接，不是删除数据库。[SDK 生命周期](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/index.ts#L236-L410) [index/sync/watch](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/index.ts#L428-L677) [destroy](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/index.ts#L1214-L1245)

`indexAll` 会检查 signal，取消时返回 `success: false`/`Aborted`，但已写入行不会自动回滚；`sync` 没有公开 signal。1.1.6 没有后续版本的 incomplete marker，所以不能把半成品当作成功图。[indexAll cancel](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/extraction/index.ts#L1203-L1261) [解析循环取消](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/extraction/index.ts#L1431-L1519) [sync 无 signal](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/extraction/index.ts#L1938-L2073)

### 4.1 公开能力逐项核查

以下是对用户关心的公开能力的直接结论：

- `init`：创建 `.codegraph`、数据库和语法资源；CLI 随后全量索引。它不是“只准备目录”的轻量操作。
- `index`：CLI 层调用 `CodeGraph.recreate` 后再调用 `indexAll`，所以是破坏旧库后的全量重建。
- `sync`：只打开已有图并按文件变更同步；它没有 `AbortSignal` 参数，不能把 CLI 退出当作事务回滚。
- `status`：可输出 initialized、版本、项目/索引路径、统计、DB size、backend、journal mode、pending changes 及重建建议。
- `rebuild`：1.1.6 没有这个命令名；Harness 可以提供别名，但必须在帮助和日志中说明其底层是 `index`/`recreate`。
- `cancel`：只有 SDK 的 `indexAll` 接受 `AbortSignal`；MCP 和 CLI 没有独立的构建取消协议。

因此 adapter 的最小协议应区分 `started`、阶段进度、`succeeded`、`failed`、`cancelled` 和 `incomplete`，而不是只转发终端输出。`status --json` 是完成后的二次检查，不是对取消事务的恢复保证。[状态输出](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L761-L832) [SDK index options](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/index.ts#L112-L125)

建图操作也应把 stdout 与 stderr 分离：stdout 只承载 adapter 自己定义的 JSONL 事件，CodeGraph 的诊断和用户可读日志进入 stderr。这样不会依赖 CLI 的 ANSI 动画、文案或版本变化；这条是 Harness 的适配约束，不是对上游增加的新 API。

## 5. MCP、daemon、session 和 watcher

`serve --mcp --path <workspace>` 是 1.1.6 的 stdio MCP 入口，可用 `--no-watch`。MCP 有 direct、proxy、daemon 三种形态；`CODEGRAPH_NO_DAEMON=1` 强制 direct，否则已有 `.codegraph` 时可能连接每个项目一个的共享 daemon。[serve](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/bin/codegraph.ts#L1490-L1563) [模式选择](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/mcp/index.ts#L17-L29) [启动路径](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/mcp/index.ts#L90-L368)

MCP session 先返回 initialize/工具列表，再异步打开图、启动 watcher 和 catch-up sync；默认工具主要是 `codegraph_explore`，其他工具由 `CODEGRAPH_MCP_TOOLS` allowlist 控制。1.1.6 没有 MCP index/build 工具。[session](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/mcp/session.ts#L163-L269) [工具 allowlist](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/mcp/tools.ts#L748-L774) [engine catch-up](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/mcp/engine.ts#L133-L312)

推荐受管模式：给 CodeGraph 子进程设置 `CODEGRAPH_NO_DAEMON=1`，每个 workspace 保持一个长生命周期 stdio 查询进程和 session；不要每次工具调用重建 session。全量重建前先关闭查询进程和 watcher，完成/失败后再启动。daemon 是 detached 进程，有 pid、socket、锁和 idle/refcount 回收，不能假设父 Host 退出就会退出。[daemon 生命周期](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/mcp/daemon.ts#L156-L340)

watcher 使用 `fs.watch`：macOS/Windows 尝试递归监听，Linux 按目录监听；`CODEGRAPH_NO_WATCH=1` 禁用，WSL2 `/mnt` 会按策略禁用，watch 资源耗尽时退化为手动 `sync`/git hook。[watcher](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/sync/watcher.ts#L1-L31) [限制和策略](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/sync/watcher.ts#L323-L384)

### 5.1 进程状态与重建顺序

建议 Host 维护以下可观察状态：

| 状态 | 进入条件 | 允许的下一步 |
| --- | --- | --- |
| `idle` | 没有索引任务，查询服务可选 | `init`、`sync` 或 `index` |
| `running` | 子进程已启动并报告阶段 | 继续、取消或超时 |
| `succeeded` | 子进程正常退出且 status 校验通过 | 启动/恢复 MCP 查询 |
| `cancelled` | 用户取消或 Host 发出终止 | 显示重试；不开放半成品查询 |
| `incomplete` | 非正常退出、超时、SIGTERM 或 status 不一致 | 显式重建或按策略清理后重试 |
| `failed` | 参数、锁、权限或数据库错误 | 修正环境后重试 |

全量重建顺序固定为：停止受管 MCP session → 停止 watcher → 获取/检查 lock → 执行 `index` 或 SDK `recreate` + `indexAll` → 检查退出码和 status → 重新启动 MCP session。任何中途失败都不能跳过最后的状态归类。

若发现外部 daemon 或另一个 CodeGraph 进程持有锁，Harness 只能等待、提示或取消自己的任务，不能杀掉其他产品的进程；这是企业集成必须通过实测确认的协作边界。[FileLock ownership](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/utils.ts#L217-L333)

## 6. 离线、数据库锁和恢复

npm shim 在平台包缺失时会从 GitHub Releases 下载；设置 `CODEGRAPH_NO_DOWNLOAD=1` 才会禁止。checksum 文件缺失或不可达时是 best effort，企业应在制品入库阶段独立校验 tarball。[shim 下载回退](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/npm-shim.js#L1-L27) [平台解析](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/npm-shim.js#L44-L116) [checksum](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/scripts/npm-shim.js#L192-L216)

遥测默认开启，端点为 `https://telemetry.getcodegraph.com/v1/events`；`DO_NOT_TRACK=1` 或 `CODEGRAPH_TELEMETRY=0` 可关闭。企业子进程至少设置 `CODEGRAPH_NO_DOWNLOAD=1`、`DO_NOT_TRACK=1`，可再设 `CODEGRAPH_TELEMETRY=0`。[telemetry](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/telemetry/index.ts#L1-L36) [发送和配置](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/telemetry/index.ts#L183-L203)

1.1.6 没有后续 1.4.1 才加入的 `CODEGRAPH_NO_UPDATE_CHECK`；不要把它当作本版本开关。不要调用显式 `codegraph upgrade`，并用企业网络策略阻断未授权外联。[后续 update-check 变量](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L225-L234) [1.1.6 upgrade 路径](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/upgrade/index.ts#L29-L34)

写操作使用 `.codegraph/codegraph.lock` 独占文件锁和 PID；SQLite 配置 busy timeout、WAL 和 `synchronous=NORMAL`。`recreate` 会删除数据库及 WAL/SHM sidecar；Windows 仍有 holder 时可能 `EBUSY`，所以重建前必须关闭受管 MCP 进程和 watcher，不能终止外部产品进程。[FileLock](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/utils.ts#L217-L333) [SQLite](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/db/index.ts#L17-L38) [删除 DB 文件](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/src/db/index.ts#L299-L327)

1.1.6 全量重建先丢弃旧库，取消/超时/杀进程可能留下部分图；没有旧图原子切换，也没有 incomplete marker。Harness 必须自己维护 `running/succeeded/incomplete/failed/cancelled`，只有正常完成并通过 `status --json` 才允许查询；否则显式重试或重建。后续版本才增加未完成索引可见/修复和 WAL/强杀恢复，这些不能回溯给 1.1.6。[后续中断恢复](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L265-L300) [后续 WAL 恢复](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L106-L130)

## 7. 相对后续版本的风险

以下只用 v1.6.0 固定 commit 的 changelog 说明 1.1.6 缺少哪些后来修复：

| 后续修复 | 1.1.6 风险与处理 |
| --- | --- |
| v1.2.0：大项目 resolution watchdog 让出执行、自动同步失败 backoff | 大仓库可能误杀、变慢或重复重试；Host 必须有超时和退避 |
| v1.3.0：incomplete marker/status、下一次 sync 修复中断图 | 1.1.6 取消后状态弱；Host 自己标记 incomplete，不宣称自动恢复 |
| v1.3.1/v1.4.0：大索引尾段内存、慢盘 timeout、WAL 改进 | 必须实测大仓库、慢盘、WAL 和 kill/restart |
| v1.5.0：Rust native engine | 1.1.6 是纯 JS/WASM 基线，首期要测内存、时间和语言覆盖 |
| v1.6.0：强杀后的 WAL、daemon PID、DB index/salvage 恢复 | 1.1.6 不应宣称同等级故障恢复 |

[v1.2/v1.3](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L265-L334) [v1.3.1/v1.4](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L244-L263) [v1.5](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L160-L194) [v1.6](https://github.com/colbymchenry/codegraph/blob/dfccdf62547fcd76d343344d823a0e1998d3a89f/CHANGELOG.md#L106-L130)

1.1.6 自身包含旧索引过大时 `codegraph index` 直接重建数据库的修复，说明显式全量重建是预期路径，但不等于保留旧图或原子切换。[1.1.6 changelog](https://github.com/colbymchenry/codegraph/blob/da72946d25e112f662f5a60c6b69f363aec60f16/CHANGELOG.md#L336-L342)

### 7.1 本次评估仍未证明的事项

以下事项不能由上游 tag 单独推出，必须由企业包验收补证：

- 内部 registry 是否同时镜像主包和每一个目标平台包，以及是否保留 tarball 原始文件。
- 企业包是否与上游 commit 的打包脚本产物一致，是否被重新打包、删减或替换 Node runtime。
- Linux glibc 最低版本、Windows ARM 实际设备、macOS 系统版本和文件系统类型是否满足运行条件。
- 内部安全策略是否允许子进程创建配置后的 `.harness-index`、WAL/SHM、lock、socket 和 watcher。
- 企业代理、防火墙和杀毒软件是否会改变 detached daemon、stdio、命名管道或文件锁行为。
- 真实仓库在纯 JS/WASM 1.1.6 下的峰值内存、耗时、语言覆盖和异常恢复边界。

这些未知项不会改变“可按受管 Node 子进程试点”的判断，但在 Task 验收前不能省略。

## 8. 企业包验收清单

1. 读取实际主包和平台包 manifest/tarball，确认主包与匹配平台包均为 `1.1.6`，文件包含 `npm-shim.js`、`npm-sdk.js`、`dist/index.d.ts`、随包 Node、`lib/dist`、生产依赖和 `bin`。
2. 对纳入矩阵的 macOS ARM/x64、Linux x64/ARM64、Windows x64（以及确实支持的 Windows ARM）断开公网运行 `init`、`status --json`、查询、`sync`、全量 `index` 和重启后查询。
3. 移除/降级系统 Node，验证仍由平台 bundle 运行；验证 Bun TUI 不直接加载 SDK。
4. 验证 `CODEGRAPH_NO_DOWNLOAD=1`、`DO_NOT_TRACK=1`、`CODEGRAPH_TELEMETRY=0` 后无外联；不调用 `upgrade`。
5. 覆盖中文/空格路径、只读目录、外部锁、Windows `EBUSY`、watcher 耗尽、取消、超时、SIGTERM/宿主崩溃、WAL/SHM 异常和重试；不得遗留受管孤儿进程。
6. 在 Harness 自身 TS/Python 混合仓库验证符号、调用链、JSON-RPC 边界、多 Thread 长 session，以及从探索到编辑的 Snapshot 规则。
7. 记录首次/增量耗时、查询延迟、峰值内存、DB/WAL 大小和未命中率；没有实测不承诺性能或 token 节省。

验收报告至少保留以下证据：

- 主包 `package.json`、每个目标平台包的 `package.json` 和 tarball 文件列表。
- 离线启动时的环境变量、网络观测结果、Node 实际路径和 CodeGraph 版本。
- 每种终态的 JSONL 事件、stderr 摘要、退出码和 `.harness-index` status。
- 取消、SIGTERM、强制杀进程后下一次启动的实际行为；不能用“进程退出码为 0”代替数据完整性检查。
- 目标仓库规模、语言分布、磁盘/内存和耗时基线，便于后续升级到带 native engine 的版本时比较。

当前结论是“1.1.6 具备可集成的源码基础，企业包和故障语义仍需验证”，不是“企业现有单个包已经可以上线三平台”。

## 9. 建议进入 Task 的范围

纳入：默认关闭的实验开关；TS/Bun 内置 `/code-index`；Python Host 管理 Node 子进程、持久 MCP session、锁、取消、超时和回收；通过 `CODEGRAPH_DIR=.harness-index` 使用供应商无关的单段目录；映射 `init`/`sync`/`index`/`status --json`；精确版本 preflight；离线环境变量和 incomplete 状态；企业平台验收。

不纳入：默认开启；为了使用 `.harness/index` 而维护上游 fork、patch 或链接伪装；Bun 进程内直接 import SDK；Python 重写解析器；自造 Rust kernel；向量库、跨仓库后台服务、自动升级器；把 `rebuild` 宣称成上游已有 CLI；把后续 native engine、WAL 恢复或旧图原子切换能力回溯给 1.1.6。

Task/Spec 阶段应先引用本文锁定版本和进程边界，再确认协议字段、状态语义、平台矩阵和验收数据；本文仍是 research，不替代 Task 或 Spec。

## 10. 停点 D 实测（2026-09-15）

当前机器已安装 `@colbymchenry/codegraph@1.1.6` 与 `@colbymchenry/codegraph-darwin-arm64@1.1.6`。主包/平台包 `version` 均为 1.1.6，`license` 字段为 MIT，tarball 内无独立 LICENSE 文件。平台包含随包 `node`、`lib/dist/bin/codegraph.js` 与 WASM。主包 optionalDependencies 含 `win32-arm64`，Harness 仍拒绝该 target。Linux/Windows 真机未跑，只作为去实验门槛。

macOS 离线闭环（`pytest -m codegraph_integration`）：临时 2 文件 fixture 上首建、查询、增量、重建、取消尝试、干净重启和删除通过；工作区只有 `.harness-index/`，断网环境变量 `CODEGRAPH_NO_DOWNLOAD=1`。真实 `sync` 在 SDK 未返回 `{success:true}` 时曾被 adapter 误判失败，已改为仅在 `success === false` 时失败。第二次 rebuild 的 cancel 若停在 preparing，测试改为有界等待后 close，不把卡住写成成功。

三仓评测 runner：`packages/agent/.venv/bin/python packages/agent/tests/code_index/eval_runner.py --out tmp/hc180-eval`。模式是把问题相关文件复制到临时工作区再索引，不是完整中大型仓库全量建图。Commit：Harness `1158f29`，Qwen Code `0d56e50b64`，DeepAgents `03436b369`。未跑真实模型，因此没有 token 或工具调用数；下面是 grep 基线与 `codebase_explore` 命中。

| 仓 | 问题 | 基线命中 | 索引命中 | 首建 ms | 查询 ms | files | symbols | db/WAL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Harness | H1/H2/H3 | 是 | 是 | 509 | 67/8/4 | 4 | 77 | 381KiB / 1.6MiB |
| Qwen Code | Q1/Q2 | 是 | 是 | 922 | 96/18 | 26 | 606 | 3.1MiB / 4.9MiB |
| DeepAgents | D1/D2 | 是 | 是 | 620 | 71/10 | 17 | 461 | 1.4MiB / 4.1MiB |

本轮切片上索引与 grep 都命中，没有观察到退化，也没有证明固定收益。峰值内存未采集。完整中大型仓库全量建图仍待后续。
