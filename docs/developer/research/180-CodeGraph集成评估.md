# CodeGraph 集成可行性与候选方案

评估日期：2026-09-14。Harness 基线：`8f057d4`。本地 CodeGraph HEAD：`3ed73bc`（2026-09-09）；版本事实以本地 tag `v1.6.0`（`dfccdf62547fcd76d343344d823a0e1998d3a89f`）核查。

本文只提供研究结论与候选方案，不是已确认的 Task、Spec、Plan 或开发授权。没有修改产品代码、安装依赖或重建索引。未读取企业镜像中的实际 tarball，也未做三平台运行验收；不能据此证明企业内部包与上游发布产物完全一致。

## 1. 结论

可以集成。Python 与 TypeScript 的异构不是主要障碍：让 CodeGraph 在自己的 Node 进程里运行，Python AgentHost 管理它，模型通过现有 MCP 调用探索工具即可。无需移植解析器，也无需让 Python 直接读取 CodeGraph 数据库。

真正需要补齐的是平台发行物，以及索引构建、更新、取消、查询的生命周期。仅有 `@colbymchenry/codegraph@1.6.0` 主包通常不够：上游发布的主包主要提供启动器、SDK 入口和类型声明，实际运行时与程序位于对应平台的 optional dependency 中。

推荐产品命令为 `/code-index`。默认首次建立、后续增量更新；另提供 `status` 与显式 `rebuild`。建索引是确定性程序操作，不消耗一次模型对话来决定该运行什么命令。

## 2. 企业需要哪些包

源码根目录 `package.json` 是开发依赖描述，不能把它当成 npm 发布包的最终 manifest。1.6.0 的发布形状由 [pack-npm.sh](https://github.com/colbymchenry/codegraph/blob/v1.6.0/scripts/pack-npm.sh) 生成。

| 企业镜像需要的包 | 用途 |
| --- | --- |
| `@colbymchenry/codegraph@1.6.0` | 启动器、官方 SDK 入口、类型声明 |
| `@colbymchenry/codegraph-darwin-arm64@1.6.0` | Apple Silicon macOS |
| `@colbymchenry/codegraph-darwin-x64@1.6.0` | Intel macOS |
| `@colbymchenry/codegraph-linux-x64@1.6.0` | Linux x64 |
| `@colbymchenry/codegraph-linux-arm64@1.6.0` | Linux ARM64 |
| `@colbymchenry/codegraph-win32-x64@1.6.0` | Windows x64 |
| `@colbymchenry/codegraph-win32-arm64@1.6.0` | Windows ARM64 |

企业源镜像目标机器需要的全部平台包；每台机器只安装匹配平台的一份。三大操作系统不必然要求六种架构，实际支持集合应以企业设备清单为准，但不能只在 macOS 上安装成功就宣布三平台支持。

上游平台包内含 Node、编译后的 JS、生产依赖和语法资源；发布流程还要求带上 Rust 提取内核的 `.node` 文件。Node 内置 SQLite，因此正常使用官方完整平台包时，不需要用户另装 SQLite、Rust、C/C++ 编译器或 Python 版解析器。自行从源码构建是另一条更重的供应链，不建议首期采用。[构建脚本](https://github.com/colbymchenry/codegraph/blob/v1.6.0/scripts/build-bundle.sh)、[发布流程](https://github.com/colbymchenry/codegraph/blob/v1.6.0/.github/workflows/release.yml)。

需要保留以下限制：

- Linux 发布内核目标是 GNU/glibc，不能推导出支持 Alpine/musl 或全部旧版发行版。
- Windows/macOS 的最低系统版本要按随包 Node 和原生内核的要求实测确认；有构建产物不等于企业目标设备都运行过。
- optional dependency 缺失可能不使包管理器安装失败。必须检查匹配平台包和运行时文件，不能只看主包版本。
- 1.6.0 启动器在缺少平台包时会尝试从 GitHub Releases 下载。企业集成应在进程启动前确认包齐全，并设置 `CODEGRAPH_NO_DOWNLOAD=1`，缺失时报告具体包名，不在使用阶段临时补公网依赖。[启动器](https://github.com/colbymchenry/codegraph/blob/v1.6.0/scripts/npm-shim.js)。

## 3. 为什么不直接导入 Bun，也不用改写成 Python

1.6.0 已有官方 SDK，不能沿用历史 issue 中“npm 包没有库入口”的结论。但它的 SDK 在调用者自己的 JS 运行时中执行，数据库实际使用 `node:sqlite`，至少要求 Node 22.5；大规模 WASM 提取还依赖 Node/V8 的 `--liftoff-only` 启动选项。

Harness 当前使用 Bun 1.2.19。不能因为两边都有 TypeScript，就认定将 SDK import 到 TUI 进程即可运行。推荐直接用平台包随带的 Node 启动独立进程，避免要求用户另外维护系统 Node，也避免把索引 CPU/内存负载放到界面进程。[SDK 入口](https://github.com/colbymchenry/codegraph/blob/v1.6.0/scripts/npm-sdk.js)、[SQLite 实现](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/db/sqlite-adapter.ts)。

Python 端只管理子进程和协议，不执行 CodeGraph 的解析逻辑。TS 与 Python 文件可以在同一工作区索引，但这不等于它能自动还原任意跨语言运行时调用：例如 Harness 的 TS JSON-RPC 方法到 Python handler，首期仍需模型结合 protocol 定义与两端源码追踪。不能把“支持多种语言”宣传成“能完整理解任意异构调用链”。

## 4. 推荐接入结构

```text
用户输入 /code-index
    → CLI 共享交互控制器
    → 已有 JSON-RPC 通道上的索引操作
    → Python AgentHost：工作区、状态、互斥、取消
        ├─ 建立/更新：随包 Node + 薄适配脚本 + 官方 CodeGraph SDK
        └─ 仓库探索：既有 MCP 管理器 + CodeGraph stdio server
                  ↓
             当前工作区的 .codegraph/
```

包职责保持现有分层：

- `cli`：斜杠命令、进度、错误、完成提示，TUI/Web 复用共享控制器。
- `protocol`：必要的索引启动、状态、取消与进度契约；具体方法名在后续规格阶段确定。
- `agent`：工作区权限、进程监督、索引操作与 MCP 生命周期。薄 Node 脚本是 Host 管理的辅助资源，业务语义仍归 Python Host。

### 构建为什么需要一个薄适配脚本

直接执行 `codegraph init --yes` 适合人工试用，但正式集成存在两个具体问题：

1. 在监听不可用的环境，`--yes` 会替用户选择安装 Git hooks。它不只是“自动回答、不修改其他东西”。见 [offerWatchFallback](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/installer/index.ts#L662)。
2. CLI 面向终端输出进度，没有统一的索引 JSON 事件接口；解析动画、ANSI 或输出文案会形成脆弱依赖。

建议一个很薄的脚本调用公开的 `CodeGraph.init`、`indexAll`、`sync`、`getStats` 与清理方法，把 `onProgress` 转为有限的 JSONL 事件。正常退出、错误和取消都必须可区分，SDK 日志进入 stderr，stdout 保持结构化。脚本只做传输适配，不复制索引算法、数据库 schema、文件监听器或依赖解析器。[公开入口与进度回调](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/index.ts)。

使用随包 Node 的绝对路径及参数数组启动；Windows 使用 `node.exe`，不拼接 shell 字符串或依赖 `.cmd`。SDK 入口和辅助脚本必须由 Harness 安装位置解析，不能从待分析仓库加载同名 npm 包。已知包布局绑定在 1.6.0 的这一处适配中，升级时验证。

### 查询复用 MCP

1.6.0 提供 `serve --mcp --path <工作区>`，默认工具列表只暴露 `codegraph_explore`，可通过 `CODEGRAPH_MCP_TOOLS` 显式开放其他查询工具。没有可直接替代用户建索引操作的 `codegraph_index` 工具。[工具定义](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/tools.ts#L1034)。

首期复用 Harness 的 MCP 注册、连接、工具发现与调用机制，不另做一套 Python 查询工具，也不在 TS 和 Python 各接一份 MCP。索引完成后使 CodeGraph server 可用，再让下一次模型 Run 获取对应工具。

不过，现有管理器的名字不能作为“已持有持久连接”的证据：`McpConnectionManager._load_server_tools` 调用 `MultiServerMCPClient.get_tools`；本地安装的 `langchain-mcp-adapters==0.2.1` 明确为每次工具调用创建新 session。直接照用这条路径并设置 `CODEGRAPH_NO_DAEMON=1`，会反复启动服务，无法获得预期的持续 watcher。正式方案应复用该依赖已有的显式 `client.session(...)` / `load_mcp_tools(session)` 能力，让 CodeGraph 连接保留到 Host 退出或重建前关闭。仅为这个受管服务补齐生命周期，不顺手改造所有 MCP server。

| Harness 现有能力 | 可复用位置及需要补齐的部分 |
| --- | --- |
| 统一斜杠命令 | [commands.ts](../../../packages/cli/src/interactive/commands.ts)、[command-dispatcher.ts](../../../packages/cli/src/interactive/command-dispatcher.ts)：增加确定性的内置命令，不用最终会转为模型 prompt 的插件命令替代 |
| MCP 配置、工具发现、失败隔离 | [mcp.py](../../../packages/agent/harness_agent/extensions/mcp.py)：复用连接和工具适配；补受管 CodeGraph 持久 session 与关闭路径 |
| MCP generation 更新、旧引擎 draining | [agent_host.py](../../../packages/agent/harness_agent/host/agent_host.py)：沿已有资源交接机制接入；重建须等待占用释放，不能把 generation 切换当作旧资源已关闭 |
| 延迟工具发现 | [harness_tools.py](../../../packages/agent/harness_agent/tools/harness_tools.py)：确保 `tool_search` 能发现 CodeGraph，并提供简短的使用指导 |
| 模型运行进度与取消 | 当前 `run.progress` 只表达 `preparing/model`，不能拿它当现成的本地索引 job；需给确定性索引操作补协议与表现 |

当前 Harness 没有明确把 MCP initialize 中的 server instructions 注入模型的路径。模型可以看到工具 description，但不能假设上游的完整使用指南自然生效。应通过现有 Agent 指导入口说明何时使用 CodeGraph、何时回退，以及编辑前的 Snapshot 规则。

用户配置的 MCP add/remove 可在当前 Host 更新 generation；Plugin catalog 则在启动时冻结。因此一个静态 MCP 配置可以用于试点，但“通过安装/启用插件立即实现 `/code-index` 全流程”不成立。内置功能应从 Host 启动时就具备接入定义，不依赖运行中重载 Plugin catalog。

CodeGraph 支持 MCP 启动后重试发现后来建立的索引，但也会向父目录查找索引。必须显式绑定 workspace，检查最终索引根；不能误用父仓库或相邻项目的图。[索引发现](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/engine.ts)。

## 5. 建议的用户行为

| 操作 | 预期行为 |
| --- | --- |
| `/code-index`，尚无索引 | 核查平台包和工作区，建立索引；显示阶段、已处理数量和完成统计 |
| `/code-index`，已有索引 | 增量更新，不默认全量删除重建 |
| `/code-index status` | 显示索引根、版本、文件/符号统计、当前操作与查询是否可用 |
| `/code-index rebuild` | 显式全量重建，先协调关闭查询和监听，再执行重建 |
| 用户取消 | 终止本次构建及其工作进程；标记未完成，不能显示成功或继续使用半成品 |
| 后续自然语言探索 | 模型优先用 `codegraph_explore` 定位；未命中、未覆盖或过期时允许普通搜索与读取 |

首期命令只作用于当前 Host 的工作区，不接受任意目录参数。建索引与模型 Run 分开，不把本地构建伪装成一轮模型消息。进度只显示实际回调提供的阶段/计数，不编造整体百分比。

不建议首期附带图形化浏览器、后台跨仓库索引服务、自动安装/升级器、向量数据库、嵌入模型或跨语言协议推断器。这些都不是实现当前用户结果的前提。

## 6. 必须处理的几个边界

### 数据库重建与进程生命周期

`CodeGraph.recreate` 删除数据库文件后重建。Windows 上仍被 MCP 占用会失败；POSIX 上删除打开的文件也可能使旧连接继续看到旧数据。因此不能一边查询/监听一边重建。[recreate](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/index.ts#L381)。

推荐首期给 Harness 管理的服务设置 `CODEGRAPH_NO_DAEMON=1`，让 Python Host 清楚拥有该 stdio 进程。工作区内同一时刻只运行一次受管索引操作；构建前协调已有调用与 watcher，完成后重连。重复启动、取消、超时、Host 退出、构建失败都收敛为明确状态。

这个设置不能阻止其他编辑器启动同目录的 CodeGraph。发现外部占用时应提示关闭占用者或稍后重试，不结束其他产品的进程。跨 Host/外部进程的锁行为须在正式开发前专项验证。

首期不承诺全量重建失败仍保留可查询的旧索引：上游接口没有这个保证。失败/取消后标记不可用并允许重试；如需无中断切换旧图，应另行设计临时索引与切换，不能假装是简单包装已提供的能力。

### Snapshot 编辑约束

CodeGraph 的工具描述会建议“不必再次 Read，可直接 Edit”。Harness 的编辑工具要求当前 Thread 的 Snapshot。两者不能直接互换：CodeGraph 负责定位与理解；真正编辑之前仍用 Harness `read_file` 获取 Snapshot。不能把 MCP 返回的源码伪装成 Snapshot，也不能用 CodeGraph 提示覆盖本机文件安全规则。

### 多 Thread 的工具会话

CodeGraph 1.6.0 会按 MCP session 省略已经返回的源码。当前逐调用 session 不等于已经存在跨 Thread 去重缺陷；但采用本方案的 Host 级持久 session 后，多个 Thread 会共享服务端会话，另一个 Thread 或压缩后的上下文可能收到“此前已发送”却并未持有源码。首期可设置 `CODEGRAPH_EXPLORE_DEDUP=0`，先保证每次结果自足，再验证会话隔离是否值得实现。[去重开关](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/explore-dedup.ts#L74)。

### 企业离线运行

1.6.0 默认开启匿名使用统计，并有升级检查；本地索引不等于绝无网络行为。建议只给 CodeGraph 子进程传入 `DO_NOT_TRACK=1`、`CODEGRAPH_NO_UPDATE_CHECK=1`、`CODEGRAPH_NO_DOWNLOAD=1`；不改用户全局配置。依赖全部由企业包源或产品发行物提供。[遥测开关](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/telemetry/index.ts#L185)、[更新检查](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/upgrade/update-check.ts)。

工作区信任和索引范围仍由 Harness 决定；不能让模型通过 MCP 的 `projectPath` 参数自由越出已授权工作区。目录忽略规则和 CodeGraph 索引是派生数据能力，不替代访问控制。

## 7. 开发前最小验证

1. 读取企业实际主包 manifest、完整性信息和文件列表，确认是否包含预期的 SDK 入口及匹配版本的平台包；不要用上游 tag 代替这一步。
2. 在目标 Windows、macOS、Linux 上，仅用企业提供的完整发行物，断开公网完成首次建索引、探索、增量更新与全量重建；没有系统 Node 也能运行。
3. 覆盖带空格和中文的路径、退出/取消、索引被其他进程占用、只读目录、数据库异常、构建中断后的恢复；失败有明确提示，没有孤儿进程。
4. 在 Harness 自身 Python/TS 混合仓库验证真实问题：符号定位、同语言调用链、跨 JSON-RPC 边界追踪；记录未命中与错误关系，不能只看节点数量。
5. 验证同一 Host 多 Thread、子代理、上下文压缩后的结果仍完整，以及从探索到编辑仍执行 Snapshot 读取。
6. 用企业真实模型比较普通搜索与 CodeGraph：答案准确率、工具调用次数、总 token、总耗时、首次索引时间和磁盘/内存占用。没有测量前不承诺具体节省比例。

当前结论是“1.6.0 具备实现所需的基础能力，推荐独立 Node 进程 + 官方 SDK 构建 + MCP 查询”；尚未达到“企业现有单个包即可直接上线三平台”的证据程度。
