# 本地日志与离线诊断

Harness Code 内置本地优先、低流量、结构化的异步诊断日志。CLI 与 Python sidecar 各自记录生命周期事件、执行结果与关键耗时；日志完全单向、独立于 Thread 恢复 SQLite，不参与业务状态重建，也不向任何远程服务上传遥测。本页自包含日志的全部用户操作；排障视角见[故障排查 §20](troubleshooting.md#20-使用本地诊断日志排查故障)。

## 存储位置、文件命名与生命周期

日志按执行日期分目录存放在用户主目录下，目录权限 `0700`、文件权限 `0600`（Windows 用当前登录用户访问控制）：

| 操作系统 | 路径 |
| --- | --- |
| macOS / Linux | `~/.harness/logs/<YYYY-MM-DD>/` |
| Windows | `%USERPROFILE%\.harness\logs\<YYYY-MM-DD>\` |

> 旧文档中 `~/.harness/debug` 的说法已过期，当前实现只使用 `~/.harness/logs`。

CLI 与 Python Agent 在各自进程独立写入文件，互不竞争文件锁。文件名形如 `cli-41230-1787800000000-0001.jsonl`（`agent-…` 同理），结构为 `<component>-<pid>-<启动毫秒>-<分片序号>`：

- **活跃文件**：正在写入的文件以 `.active.jsonl` 结尾。
- **已关闭归档**：进程正常退出或触发单文件容量轮转时，先关闭再重命名为标准 `.jsonl`。
- **孤儿活跃文件**：进程被强杀（如 `kill -9`）时 `.active.jsonl` 原样保留。查询工具会安全读取其中的有效数据并在诊断统计中提示；**清理策略绝不删除或重命名活跃文件**，避免误删可能仍在写入的日志。

## 轮转与清理

| 策略 | 默认值 |
| --- | --- |
| 保留时间 | 14 天 |
| 日志目录总量上限 | 200 MiB |
| 单文件分片上限 | 约 16 MiB（达到即关闭并开新分片） |

清理只针对**已关闭的 `.jsonl`**；正在写入的 `.active.jsonl` 永不触碰。三项均可在用户级配置调整（见下）。

## 配置与级别

### 用户级 `[diagnostics]` 配置

在 `~/.harness/config.toml` 中持久配置（**重启 Harness 后生效**）：

```toml
[config]
version = 1

[diagnostics]
# 级别："debug" | "info" | "warn" | "error"，默认 "info"
level = "info"

# 历史日志保留天数（默认 14）
retention_days = 14

# 日志目录总容量上限（MiB，默认 200）
max_total_mib = 200

# 单文件分片上限（MiB，默认 16，不得大于 max_total_mib）
max_file_mib = 16
```

### 环境变量临时覆盖

`HARNESS_LOG_LEVEL` 优先级高于配置文件，同样重启/下次启动生效，适合临时复现问题：

```bash
# 在仓库根目录，只用于复现问题
HARNESS_LOG_LEVEL=debug npm run dev
```

### 级别语义

- `info`（默认）：进程启动/关闭、Run 开始与终态、模型轮次耗时、工具执行状态、MCP 连接、Skill 读取、Hook 执行与上下文压缩。
- `debug`：增加状态机流转、Runtime Pool 快照、模型重试决策、脱敏异常栈与诊断详细信息。
- `warn` / `error`：队列溢出丢弃、写入降级、执行异常与终态失败。

## 脱敏红线（任何级别，包括 DEBUG）

1. **零业务正文**：不记录 Prompt、LLM 补全正文、源码内容、完整工具入参与返回结果。
2. **零凭据泄漏**：不记录 API Key、Token、认证 Header、密码、环境变量值或 Secret。
3. **零工作区绝对路径**：工作区以 SHA-256 指纹（`project_fingerprint`，64 个小写十六进制字符）关联，不出现磁盘目录全路径。
4. **零协议原帧**：不记录原始 JSON-RPC 帧或网络请求全文。

所有记录通过闭合白名单 Schema 严格校验；含未声明属性或格式不合规的记录直接拒绝入队。即便如此，向外部发送诊断材料前仍应复查企业专有命名（详见[故障排查 §20](troubleshooting.md#20-使用本地诊断日志排查故障)）。

## 离线查询（`harness logs`）

`harness logs` 完全离线：直接读本地 JSONL，**不启动 Python sidecar、不访问 SQLite、查询自身也不写入新日志**。它**不接受 `--config`（含 `-c`）**。开发模式在仓库根目录执行：

```bash
npm run dev -- logs            # 等价于已安装环境下的 harness logs
```

### 1. Thread 列表（默认视图）

```bash
npm run dev -- logs
```

默认列出当前工作区最近 20 个 Thread（可复制前缀用于下一步查询），输出每条的 Thread ID 前缀、最后活动时间、Run 次数、最近结果与总耗时。

### 2. Thread 完整中文过程树（推荐主视图）

```bash
npm run dev -- logs --thread <thread-id-or-prefix>
```

输出结构：

- **摘要**：Thread 最终状态、Run 数量、有效耗时口径；
- **失败点**（如有）：哪一步失败及原因；
- **准备层**：当前进程连接的 MCP 服务等；
- **历史 Run 折叠**：早期 Run 汇总为单行（提示可用 `--run <run-prefix>` 放大）；
- **最近一轮 Run 过程树**：模型交互、工具调用、Skill 读取、Hook 触发、子代理与上下文压缩；
- **慢项统计**：耗时前 5 的操作。

### 3. 单次 Run

```bash
npm run dev -- logs --run <run-id-or-prefix>
```

`--thread` 与 `--run` **互斥**，同时给出报 `THREAD_RUN_CONFLICT`。

### 4. 过滤与条数

```bash
# 只看 WARN 及以上
npm run dev -- logs --thread <prefix> --level warn

# 只看工具事件
npm run dev -- logs --thread <prefix> --event tool

# 只看 Python Agent
npm run dev -- logs --thread <prefix> --component agent

# 自定义单页条数
npm run dev -- logs --thread <prefix> --limit 50
```

- `--level` 取值 `debug|info|warn|error`，语义是**最低级别**（`warn` 表示 WARN 及以上）。
- `--component` 只接受 `cli` 或 `agent`。
- `--limit` 必须是 1–1000 的整数。
- 多过滤条件按 **AND** 组合。
- 选择 Thread/Run 时默认每页 200 条事件；无选择器时默认 20 条 Thread。

### 5. 平铺表格与 Cursor 分页（`--flat`）

默认树形视图遇到单页上限或 256 KiB 输出保护时，不在树中间切断，而是提示改用 `--flat`：

```bash
npm run dev -- logs --thread <prefix> --flat --limit 50
```

- `--flat` 必须配合 `--thread` 或 `--run`，且不能与 `--json` 同用。
- 宽终端（≥84 列）表格列为：**时间**（本地 `HH:MM:SS.mmm`）、**级别**（如 `INFO+` 口径中的单条级别徽章）、**来源**（cli/agent）、**EVENT**、**详情**（中文摘要）、**耗时**；窄终端降级为两行式输出。
- 底部显示 `共 N 条 · 已显示 M 条 ·（已截断）`，截断时给出可直接复制的下一页命令：

```bash
npm run dev -- logs --thread <prefix> --flat --limit 50 --cursor <token>
```

Cursor 绑定首次查询时的日志快照：翻页期间有新日志写入也不会重复或遗漏。若快照失效，系统拒绝猜测位点并给出明确错误码（见下）。

### 6. 机器可读 JSON（`--json`）

```bash
npm run dev -- logs --thread <prefix> --json
npm run dev -- logs --run <prefix> --json
```

与 `--flat` 互斥；`--cursor` 对 `--flat` 或 `--json` 都可用。JSON 对象字段（schema v1）：

| 字段 | 含义 |
| --- | --- |
| `query_schema_version` | 查询输出版本，当前 `1` |
| `project_fingerprint` | 工作区 SHA-256 指纹（无绝对路径） |
| `filters` | 本次查询的生效过滤（minimum_level/event/component 等） |
| `events` | 记录数组；`--flat`/`--json` 下为原始诊断记录（含 `schema_version`、`timestamp_ms`、`level`、`event`、`component`、`thread_id`/`run_id`、`project_fingerprint`、`fields`） |
| `matched_count` / `returned_count` | 命中总数 / 本页返回数 |
| `truncated` | 是否还有下一页 |
| `next_cursor` | 续页 token（未截断时为空） |
| `diagnostics` | 解析诊断计数：`malformed_count`（非法 JSON 行）、`invalid_count`（未过 Schema）、`unsupported_schema_count`（未来 schema 版本）、`partial_line_count`（尾部半行）、`orphan_active_count` 与 `orphan_active_bytes`（孤儿活跃文件数量和字节数） |

### 错误处理

| 错误码 / 报错 | 触发条件 | 处理 |
| --- | --- | --- |
| `THREAD_RUN_CONFLICT` | `--thread` 与 `--run` 同用 | 只保留一个选择器 |
| `--flat requires --thread or --run` | `--flat` 缺选择器 | 加 `--thread` 或 `--run` |
| `--flat and --json are mutually exclusive` | 两种输出同用 | 二选一 |
| `--cursor requires --thread or --run` / `--cursor requires --flat or --json` | cursor 缺少选择器或输出模式 | 补全对应参数 |
| `--limit must be integer 1..1000` | 条数越界或非整数 | 改为 1–1000 |
| `--level must be one of debug|info|warn|error` | 级别拼写错误 | 使用四个合法值 |
| `--component must be cli or agent` | 组件值非法 | 使用 `cli` 或 `agent` |
| `LOG_ROOT_UNREADABLE` | 日志根路径不是目录或不可读取；目录不存在时返回空结果 | 确认 `~/.harness/logs` 是可读取的目录 |
| `CURSOR_EXPIRED` | 快照对应文件被轮转/缩小/替换或目录消失（含孤儿文件被外部清理） | 重新发起原始查询获取新 cursor |
| `CURSOR_MISMATCH` | cursor 与当前工作区、选择器或过滤条件不一致（cursor 为 HMAC 绑定，不可伪造） | 用**原始**过滤条件重查 |
| `INVALID_CURSOR` | cursor 过大或格式非法 | 不要手改 cursor，重新查询 |
| `QUERY_OUTPUT_TOO_LARGE` | 查询摘要或单条完整记录超过 256 KiB | 缩小范围：加 `--level`/`--event`/`--component`、降低 `--limit` 或改用更小的时间范围 |

来源：`packages/cli/src/diagnostic-log/runtime/index.ts`（默认值、权限、轮转清理）、`packages/cli/src/diagnostic-log/query.ts`（发现规则、cursor、错误码、flat/JSON 渲染）、`packages/cli/src/args.ts`（flag 解析与互斥）、`packages/agent/harness_agent/config/config.py`（`[diagnostics]` 与 `HARNESS_LOG_LEVEL`）、`packages/protocol/diagnostic-log/schema/v1.json`（记录/查询 Schema）、`docs/user/日志与诊断.md`。
