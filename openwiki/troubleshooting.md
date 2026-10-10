# 故障排查：按症状恢复

本页覆盖原「故障排查」全部 20 个二级主题，面向最终用户自包含使用：每项给出症状/稳定错误码、先检查什么、可执行的安全恢复，以及禁止的捷径。命令均在源码仓库根目录以开发模式执行（`npm run dev -- ...`）；已交付 `harness` 全局命令的环境可直接去掉该前缀。配置模型与 Provider 错误码背景见[配置页](configuration.md)；Plugin/子代理语义见[扩展页](extensions.md)；Web 与日志基础操作见[支持页](web-and-support.md)。

> 事实基线：本页以当前源码与测试核对为准。旧文档中两处已过期说法不可照抄：① Plugin `enable --capability-fingerprint` 会被当前 CLI parser 拒绝（见 `packages/cli/tests/args.test.ts`、`hc175-plugins.test.ts` 的抛错断言）；② 交互式 CLI 诊断日志目录是 `~/.harness/logs/<YYYY-MM-DD>/`，不是 `~/.harness/debug`（见 `packages/cli/src/diagnostic-log/runtime/index.ts` 与 `packages/agent/harness_agent/diagnostic_log/runtime.py`）。

---

## 1. 模型配置或 API Key 缺失

**症状/稳定码**：Run 受理前失败，提示缺少默认 Profile、`api_key_env` 对应环境变量未设置，或配置解析错误；`config show` 显示 `api_key_source=missing`。

**先检查**：

- `~/.harness/config.toml`（或 `--config` 指向的文件）包含 `[config]`（`version = 1`）、`[models]` 与 `default_profile` 指向的已定义 Profile；字段校验规则见[配置页](configuration.md#模型-profile-与能力)。
- `api_key_env` 指定的环境变量在**启动 Harness 的同一终端会话**中已设置。
- 工作区 `.harness/config.toml` / `.harness/config.local.toml` 不会自动加载，检测到会在模型请求前拒绝——这是保护行为，把团队配置迁移到用户级配置，或用 `--config` 显式指向。

**安全恢复**：

```bash
npm run dev -- config path
npm run dev -- config show
```

`config show` 输出脱敏有效值与 `api_key_source=environment|toml|missing`，不含密钥。修好后重发下一条消息开启新 Run。用户级 TOML 允许低安全性的明文 `api_key` 降级值，加载器会在支持 POSIX 权限的平台自动收紧文件权限；显式配置与工作区配置一律不接受明文密钥。

**禁止**：把真实密钥贴进截图、Issue、终端回显或仓库文件；为绕过工作区配置拒绝而手改校验逻辑；用 `HARNESS_API_KEY` 以外的空值占位。

## 2. Python sidecar 无法启动或依赖不同步

**症状**：启动时报 Python 环境缺失、包导入失败、`initialize` 握手失败，或依赖检查脚本报锁文件/包源不匹配。

**先检查**：

- Python `>=3.11,<4.0` 与 uv 可用；`packages/agent/.venv` 是否由本仓库依赖同步创建。
- 企业内 `npm config get registry` 与 `python -m pip config get global.index-url` 指向企业源；当前配置的源优先级高于 `HARNESS_NPM_REGISTRY` / `HARNESS_PYPI_INDEX`，后者只在「工具配置仍是公网、这一次要装内网依赖」时临时设置。
- `--cwd <路径>` 指向的工作区必须已存在，CLI 不创建它；显式 `--config` 建议绝对路径。

**安全恢复**：

```bash
npm run deps:sync
```

它检查 npm/pip 包源、工具版本、锁文件来源，同步 JS/Python 并应用 DeepAgents 补丁。只有依赖声明或包源变化时才 `npm run deps:sync -- --update-lock`。需要临时指定解释器时设置 `HARNESS_AGENT_PYTHON`。

**禁止**：用单独 `uv sync` 代替 deps:sync（不会应用项目补丁）；复制其他机器的 `.venv` 或 `node_modules`；把企业内网地址写进示例或 Issue。

## 3. OpenTUI 原生包缺失

**症状/稳定提示**：依赖同步输出 `installed native package missing` 或 `missing non-empty native library`；TUI 无法启动或缺 native artifact。

**先检查**：当前配置的 npm 源能否提供本机平台/架构的 OpenTUI `0.4.3` optional package（如 Apple Silicon 是 `@opentui/core-darwin-arm64@0.4.3`；Windows x64 的 native 包由仓库 `third_party/npm/@opentui/core-win32-x64` 临时分支提供）。

**安全恢复**：确认源可提供后重新 `npm run deps:sync`。Linux 默认 glibc；musl 环境需：

```bash
export OPENTUI_LIBC=musl
npm run deps:sync
```

`OPENTUI_LIBC` 只接受空值、`glibc` 或 `musl`。

**禁止**：复制其他机器的 `node_modules` 绕过平台门禁；项目不会自行编译或回退到不匹配的平台库，不要手工伪造平台包。

## 4. Plugin 校验、安装或启用失败

**症状/稳定码**：`plugins validate|install|list|inspect|enable|disable|update|remove` 返回 `PLUGIN_*` 稳定码，或 `inspect` 显示组件 warning。

**先检查**：区分操作层级——`validate` 不写 registry，只做结构校验；`install` 复制到受管 store；`enable/disable` 写 activation。`--capability-fingerprint` **不是**当前 CLI 的有效 flag（parser 会直接拒绝）：当前已核实语义是安装需真实 TTY（stdin/stdout/stderr 均为 TTY）的明确同意，不能用 `--yes` 跳过；确认后在所选 scope 直接启用（user scope 初始 `enabled`；workspace scope 的 user 记录为 `disabled`、目标 workspace override 为 `enabled`，有效 activation 即生效）。

常见码与处理：

| 稳定码 | 处理 |
| --- | --- |
| `PLUGIN_SOURCE_NOT_FOUND` / 来源类型无效 | 确认路径存在；来源只能是普通目录或 `.zip` |
| `PLUGIN_SCHEMA_UNSUPPORTED` / `PLUGIN_MANIFEST_FIELD_INVALID` | 修复 portable `plugin.json` 的 schema、name 或受约束字段；portable `mcp.json` 是 closed schema，Claude 私有字段应放 Claude `.mcp.json` 由 Adapter 处理；双 manifest 的 name/version 不一致也会拒绝 |
| `PLUGIN_MCP_SCHEMA_UNSUPPORTED` / `PLUGIN_COMPONENT_INVALID` | 看 inspect 的组件 diagnostics；坏组件只重打包该组件，不必整包重做 |
| `PLUGIN_NO_EFFECTIVE_COMPONENT` | 包格式有效但没有 Harness 可运行组件；保持 disabled 或补受支持组件 |
| `PLUGIN_STORE_TAMPERED` / `PLUGIN_STORE_MISSING` | 不手工改 store；保留脱敏现场，从受信来源重装 |
| `PLUGIN_REGISTRY_INVALID` | 见第 8 节 staging/registry |
| `inspect` 显示 `unsupported` | 不是格式损坏，是 Harness 当前不执行该能力；不要放宽 schema |

**安全恢复**：修正来源/manifest → `validate` → `install` → `inspect` 复核组件报告。启用/停用/重装/删除在**下一次 Host 启动**进入 catalog，当前 Run 不热替换。

**禁止**：用非 TTY 管道伪造安装同意；手工编辑 registry 的 enabled/trusted 字段；用放宽 schema 解决运行时连接问题（command、cwd、URL、header、认证、外部进程问题应逐项排查）。

## 5. Adapter 更新后是否需要重新授权

**症状（旧文档说法）**：旧文档描述 `authorization_state=reauthorization-required` 与 `plugins enable --capability-fingerprint` 的重新授权流程。**当前源码已不再如此**：当前 CLI 没有 `--capability-fingerprint` flag，仓库内也没有 `PLUGIN_REAUTHORIZATION_REQUIRED` 稳定码（`grep` 全仓无此码；行为见 `packages/agent/tests/test_plugin_refresh.py`）。

**当前行为（以此为准）**：

- Host 启动时用当前 Adapter 从已安装且 digest 校验通过的 package 重建 component report；同一 package 指纹未变化时保留原 enabled/trusted，Adapter 增加内部能力描述也**不阻断**已启用 Plugin，不产生重新授权状态（`test_refresh_changed_component_report_does_not_require_reauthorization`）。
- 并发 Host 刷新由 registry lock 串行化，结果幂等，不会重复扩大授权。
- 只有 package 内容变化才需要沿显式 `update`/`install` 边界重新安装。

**安全恢复**：如果怀疑 Plugin 行为变化——完整退出并重启 Harness，`plugins inspect <id>` 确认 package digest 与组件 diagnostics；只在与受信来源一致时用 `plugins update <id>` 或重装。若出现 `PLUGIN_STORE_TAMPERED` / `PLUGIN_REGISTRY_INVALID`，保留脱敏 diagnostics 并按第 8 节处理。

**禁止**：手工编辑 `registry.json`、`capability_fingerprint` 或 `trusted_capability_fingerprint` 字段；照抄旧文档的 fingerprint enable 命令（当前 parser 直接报错）。

## 6. Qwen SubagentStop Hook warning

**症状**：日志出现对 Qwen `SubagentStop` Hook 的脱敏 warning，但 child delegation 结果正常返回。

**判定**：对已命中 matcher 的该 Hook，Hook 自身异常、超时、非零退出、非空畸形输出或 runner 关闭时，Harness 记录脱敏 warning 并**返回已经完成的 child 结果**——这不是 delegation 失败。正常 blocking 沿同一 child checkpoint 继续，达到 blocking 上限时返回最新结果并附 warning。`timeout: 10000` 按 Qwen 毫秒语义仍是 10 秒。

**先检查**：结果是否确实包含 child 输出（是则无需处理）；是用户/Run/parent cancellation 则结果应显示取消而不是成功 warning；PreToolUse、权限、Policy、MCP、非 Qwen Hook 或 Hook runtime 构造/身份校验失败仍按安全策略**失败关闭**，需按对应主题排查。

**禁止**：把 Hook stdout/stderr、命令参数或宿主路径贴进 Issue；为消除 warning 而禁用安全 Hook 或改写结果。

## 7. Managed Plugin Agent 上下文异常

**症状**：受管 Plugin 子代理结果声称「上一轮 task 被取消、子代理未启动」，但本次运行明明已调用过工具。

**判定**：通常是 child checkpoint 误复用了父 Thread 或旧 child execution 的状态。当前运行时按 project、Thread、Run 和 execution 建立独立 child 根状态，并在完成、取消或失败后清理。

**安全恢复**：完整退出并重启 Harness 后重新运行该任务即可验证；若 Plugin 报告疑似过期，用 `npm run dev -- plugins inspect "<plugin-id>" --cwd "<workspace>"` 复核当前报告，再按第 5 节处理。仍有问题则保留脱敏 stderr 报告。

**禁止**：通过提示词禁止模型提及取消、过滤结果文本，或手工清理 child 状态数据。

## 8. Plugin staging 或 registry 失败

**症状/稳定码**：安装时拒绝（symlink、特殊文件、`..`/绝对路径、超大文件、压缩比异常、损坏归档）；启动时 `PLUGIN_REGISTRY_INVALID` 或 digest 校验失败。

**先检查**：staging 位于 `~/.harness/plugins/staging/`，目录与 zip 先进入私有临时目录完成结构安全检查后才进 store（`packages/agent/harness_agent/plugins/store.py`）。registry 只承认当前版本：未发布期间旧开发构建产生的旧版本 registry 不会被读取或迁移，按「版本或结构无效」失败关闭。

**安全恢复**：

1. 完整退出 Harness 与 sidecar。
2. 保留稳定错误码与脱敏 stderr 现场。
3. 删除 `~/.harness/plugins` 后从受信来源重新安装插件。

**禁止**：把压缩包解压后手工复制进 store；手工改 enabled/trusted/digest 字段；用旧代码绕过校验（旧代码不认识当前失败关闭协议）。Plugin 安装不是 OS sandbox——只有明确启用且报告为 supported/adapted 的进程组件才会启动，仍应只安装可信来源。

## 9. Windows 平台支持边界

**现状**：Windows 上 sidecar 可正常启动并完成 initialize 握手；Skill 扫描、启停、安装恢复、快照校验、AGENTS.md 参考读取与 macOS/Linux 行为一致，均 fail-closed 拒绝 symlink 与 `..` 路径穿越。

**已知差异**：

- Windows 没有 `O_NOFOLLOW`/`dir_fd`，防护为逐级 lstat 拒 symlink 并在读取前后复核文件身份；「stat 与 open 之间目录被替换」的竞态防护强度低于 POSIX。目录 fsync 在 Windows 为空操作（NTFS 由文件系统日志保证元数据）。
- 创建 symlink 需开发者模式或管理员特权；普通使用不受影响，手工构造 symlink 验证边界时可能遇到 `WinError 1314`。
- 旧库迁移 attempt 用文件身份（`st_dev/st_ino`，Windows 经 `GetFileInformationByHandle` 的卷序列号+文件索引）跨进程核对，同一卷内稳定，迁移行为与 POSIX 一致。
- 迁移子进程冷启动明显慢于 macOS/Linux，且受杀软实时扫描与磁盘负载影响；首次迁移请等待完成，**不要中途强杀进程**。启动报 `THREAD_STORE_UNAVAILABLE` 时按第 15 节处理。

**禁止**：删除 attempt/poison marker 绕过迁移门禁；把单平台测试结果当作跨平台最终用户验收。

## 10. 终端界面显示简化或被捕获

**症状**：启动后无星空/品牌动画；或界面出现 `^[[`、`rgb:`、`Warp(...)`、鼠标坐标等控制序列。

**判定**：终端小于 88×28（`supportsHomeDecoration`，`packages/cli/src/interactive/runtime.ts`）或 `TERM=dumb` 时装饰性背景主动关闭以保证可读——这是预期行为，不是故障。控制序列泄漏说明 TUI 被管道或输出捕获器启动。

**安全恢复**：扩大终端或使用支持 ANSI 的终端模拟器；在真实终端的仓库根目录用 `npm run dev -- ...` 启动交互界面。native artifact 缺失见第 3 节。

**禁止**：通过会捕获 stdout/stderr 的任务运行器启动交互 TUI；手工设置虚假的宽高或 TERM 值「骗过」装饰开关。

## 11. 网关请求失败（Provider 终态码）

**症状/稳定码**：Run 中 `model.failed` / `model.retry_scheduled`，带下表稳定码。

**先检查**：`base_url` 是企业 OpenAI 兼容接口根路径；模型名在网关可用；企业代理与必要请求头已配置（固定 header 只放非秘密值，秘密走 `headers_env` 变量名）。

模型调用在一次 Run 的配置预算内自动恢复：尚未公开的失败 attempt 不写入 Thread，半条工具调用被丢弃；**若正文/思考已公开后断流，Harness 不重放整个模型回合**（避免重复显示），保留已显示片段并返回稳定终态。`retryable=true` 表示用户修好网关后可**开新 Run**，不表示当前 Run 自动重放。

| 稳定码 | 含义与处理 |
| --- | --- |
| `MALFORMED_TOOL_CALL` | 工具调用结构不可用；尚未公开输出时丢弃该响应并按预算重试。已有正文公开则收敛为 `PROVIDER_OUTPUT_INTERRUPTED` |
| `PROVIDER_OUTPUT_INTERRUPTED` | 已显示正文/思考后断流；本轮不自动重试；修复网关后开新 Run |
| `PROVIDER_RATE_LIMITED` / `PROVIDER_RETRY_EXHAUSTED` | 429/5xx/连接超时的重试预算耗尽；无 Retry-After 时退避线性增加并封顶。`retryable=true` 表示重跑仍有意义 |
| `PROVIDER_REQUEST_REJECTED` | 400/401/403 等确定性错误，不重复请求；检查模型名、网关权限、请求头、配置来源 |
| `TOOL_CALL_ID_UNAVAILABLE` | 工具结果无法安全配对；不改 Thread 数据，保留脱敏诊断后重新运行 |

**禁止**：对已公开部分正文的回合做手动/自动重放；把 prompt、完整工具参数、响应正文、密钥或企业路径写进 Issue——只提交稳定码、attempt 序号和等待时长。

## 12. 文件 Snapshot 过期或未读取

**症状/稳定码**：文件工具返回 `STALE_FILE`、`SNAPSHOT_EXPIRED`、`UNREAD_RANGE`、`EXACT_MATCH_NOT_FOUND`、`AMBIGUOUS_MATCH`、`FILE_ALREADY_EXISTS`、`INVALID_EDIT`、`COMMIT_CONFLICT`、`POST_WRITE_DRIFT`、`BACKEND_CAS_UNSUPPORTED`、`UNSUPPORTED_FILE_TYPE`。

**安全恢复**：

- 编辑前先 `read_file` 取得当前 Thread 的 Snapshot 与唯一 `old_string`。`STALE_FILE`/`SNAPSHOT_EXPIRED`/`UNREAD_RANGE`/`EXACT_MATCH_NOT_FOUND`/`AMBIGUOUS_MATCH`：重新读取受影响区域，再提交一次唯一原文本。
- `write_file` 只创建不存在的新文件；对已有空文件返回 `FILE_ALREADY_EXISTS` 时，先读取该空文件，再以同一 Snapshot、`old_string=""` 编辑。`INVALID_EDIT` 表示文件并非空——从刚读取的非空内容复制唯一 `old_string` 重试。
- 删除文件需完整读取后的当前 Snapshot。
- `COMMIT_CONFLICT`：审批等待期间文件被外部修改，旧确认失效；重新读取并重新审查，不覆盖外部修改。
- `POST_WRITE_DRIFT`：写入完成后被保存钩子/远端改写；用返回的实际 Snapshot 与 `proposed_diff`/`actual_diff` 继续，不重放旧调用。成功结果的 `changed_range`/`shown_lines` 是新 Snapshot 的实际行号；`shown_lines` 为空表示输出按字节截断，重读后再编辑。
- `BACKEND_CAS_UNSUPPORTED`：当前远端 backend 无法安全比较并提交；切换到支持 CAS 的执行模式。
- `UNSUPPORTED_FILE_TYPE`：编码、混合换行或二进制内容无法无损处理；使用对应专用工具。
- diagnostics：`status=ok,count=0` 是 LSP 确认零问题；`unavailable`/`timeout` **不是零错误**。三种状态都不撤销成功写入。Harness 不自动跑 formatter；外部格式化会使原 Snapshot 变 stale。
- 审批 diff 截断（约 200 行/16KiB 有界预览）只是预览上限，批准仍针对完整拟议变更。

**禁止**：用盲写绕过 CAS；把 LSP unavailable 当作零诊断；期望 `replace_all`、行号批量 patch 等入口（当前不存在）。

## 13. 当前 Thread 的模型没有切换

**症状**：`/model` 或 `/models` 选择后，正在执行的 Run 仍用旧模型。

**判定**：模型选择只影响**下一次 Run**，不热切换当前 Run；等待 Thread 回到空闲（执行、等待审批、等待问题、压缩、取消中都不行）后再发下一条消息。`run.started` 事件显示的实际模型是权威结果。

**安全恢复**：选择后若提示「未来新 Thread 默认未更新」——当前 Thread 已成功切换；该提示通常对应受控写回用户级默认 Profile 失败（`config.write` 未协商、受管策略锁定、环境/CLI/显式配置覆盖、CAS 冲突、所选 Profile 缺少凭据或能力、写盘失败）。解决后再次 `/model` 即可；当前 Thread 选择不回滚，新 Thread 继续用原默认。已恢复旧 Thread 提示需新建 Thread 时，通常是 CLI 与 sidecar 协商到不含 `models.select` 的旧协议 minor：用同一版本的 CLI 与 Python sidecar 重新构建/启动。选择不可用 Profile 或服务端拒绝 `run.start` 时，原有选择和历史 Run 不会被改写。

**禁止**：手工编辑 SQLite 或 TOML 强制切换；在运行中反复执行 `/model` 期待热切换。

## 14. 协议版本或序号错误

**症状/稳定码**：`PROTOCOL_MISMATCH`；`/mcp` 同时报「Agent transport closed」和「MCP 状态查询失败」；Thread 中出现「协议序号缺口」。

**安全恢复**：

- CLI 与 Python sidecar 必须来自同一发行版本。检查是否混用旧 Python 环境或旧 CLI 构建产物；源码开发时重新 `npm run build`，确认 `HARNESS_AGENT_PYTHON` 指向本仓库 `packages/agent/.venv`。
- sidecar 在返回 MCP 状态时已退出：停止并重启 Harness，确认 CLI 与 `packages/agent` 同源；仍复现则保留 sidecar stderr。
- 序号缺口表示同一运行事件不连续，界面会继续处理后续事件；保留 stderr 与终端截图诊断。

**禁止**：把含密钥、完整工具参数或企业路径的原始 JSON-RPC 帧贴到公开渠道；为消除 mismatch 删除 MCP 配置或重装 Plugin（当前协议携带 Plugin MCP `source` 字段，升级后无需重装）。

## 15. 运行时 Skill 快照不一致

**症状/稳定码**：`RUNTIME_SKILL_SNAPSHOT_MISMATCH`——AgentEngine Profile 使用的 Skill 快照与构图阶段指纹不同。

**先检查**：通常是旧 sidecar 或旧代码残留。当前实现把策略裁剪后的 Skill view 与 Profile 使用同一指纹，并在 Skill catalog 更新时安全排空旧 Profile。

**安全恢复**：完整退出 Harness 与 Python sidecar，从仓库根目录用同一份源码重新启动。Skill 生效时机见[扩展页](extensions.md)：普通项目/用户 Skill 在下一 Run 生效，仅 Plugin Skill 变更需重启 Host。

**禁止**：手工修改 SQLite；删除 Skill 文件「修复」指纹。

## 16. 无法恢复 Thread（含数据库迁移）

**症状/稳定码**：`THREAD_NOT_RECOVERABLE`；启动阶段 `THREAD_STORE_UNAVAILABLE: <细分诊断码>`；`CHECKPOINT_MIGRATION_*` 系列。

**先检查**：使用的是交互式 `/resume` 或 `harness --resume`（只列当前 project 的 Thread，不接受手输 Thread ID）；当前 project 与创建时相同。`THREAD_NOT_RECOVERABLE` 表示索引在但 checkpoint 已不存在——开新 Thread 即可。`THREAD_STORE_UNAVAILABLE` 冒号后的稳定码说明是迁移、权限、损坏还是版本过新。

**安全恢复**（顺序严格）：

1. 完整退出所有 Harness CLI、sidecar 和 migration worker。
2. **备份** `~/.harness/threads.sqlite3` 及 `-wal`、`-shm`。
3. 只读诊断（无确认参数，会返回 `CHECKPOINT_MIGRATION_OFFLINE_CONFIRMATION_REQUIRED` 及细分原因）：

   ```bash
   cd packages/agent
   .venv/bin/python -m harness_agent.threads.migration_recovery \
     --database "$HOME/.harness/threads.sqlite3"
   ```

4. 仅当只读诊断确认全部 worker 已停、可安全写入时，才执行写入恢复：

   ```bash
   .venv/bin/python -m harness_agent.threads.migration_recovery \
     --database "$HOME/.harness/threads.sqlite3" \
     --confirm-all-harness-workers-stopped
   ```

该命令只处理严格匹配当前 attempt 的固定 marker/temp，不扫描或终止 PID，不删除 verified backup、主库或未登记文件；返回 `CHECKPOINT_MIGRATION_*` 而非 `OK_*` 时保持现场排查。

**迁移背景**：当前版本自动备份并迁移严格校验通过的 v1–v6 库；v2–v6 的旧 PromptEpoch 单向转换为 legacy RunContextSnapshot。合并前旧分支可能把完整 v6 表结构标成 `user_version=7`——没有 Transcript/Context Snapshot/Compression 后继表时，当前版本会识别并按 v6 迁移，保留 Team 状态表并生成 `threads.sqlite3.pre-v7-migration.bak` 备份。`CHECKPOINT_MIGRATION_LEGACY_TABLE_UNEXPECTED` 表示 PromptEpoch 出现在无法证明来源的 v7+ schema，必须保留原库排查。`CHECKPOINT_MIGRATION_ATTEMPT_ACTIVE` / `RECOVERY_REQUIRED` / `WORKER_EXIT_UNKNOWN` 表示上次 migration child 退出无法在线证明。

**禁止**：未备份前删除 `threads.sqlite3`、`-wal`、`-shm`；删除 attempt/poison/state/backup/`.tmp`；按记录 PID 手工判断可继续；手工改 `user_version` 或直接删旧表；回退旧代码绕过（旧代码不认识当前失败关闭协议）。

## 17. Web 工作台无法打开或立即断开

**症状**：`/web` 启动失败、浏览器未打开、页面显示「Web 接管链接无效」/「Web 接管不可用」，或 TUI 一直停在「正在回收控制权」。

**先检查**：页面只在 `http://127.0.0.1:<随机端口>` 回环地址提供；确认本机浏览器能访问回环地址、系统 `open`/`xdg-open` 可用且允许启动 GUI、CLI 与 Web 构建同版（更新代码后重新 `npm run build` 并重启 CLI）。

**参数与恢复（当前源码值）**：页面 65 秒内未上报 ready 则 CLI 归还 TUI（`readyTimeoutMs=65_000`）；首次 bootstrap token 60 秒内有效（`uiTokenTtlMs=60_000`），renderer 接管后改用每次成功重连即轮换的单次 token，长时间停留后刷新不会因首 token 超时失效；重连宽限 10 秒（`reconnectGraceMs=10_000`），宽限内刷新自动重连并重同步完整视图。失败原因常见于浏览器/企业代理/扩展/CSP 拦截随机端口的 WebSocket；重新执行 `/web` 新建会话。启动失败只显示脱敏错误并归还 TUI 输入权，不遗留监听端口。「回收控制权」卡住时先等宽限，再重试 `/web` 或退出 CLI。运行中或待审批/问题时切换受限，但取消仍可用。浏览器 DevTools 的 `[harness-web] bootstrap failed` 只保留截断诊断。

**禁止**：把端口改为对外监听；把页面 URL、bootstrap token 或 UI token 粘贴到日志、Issue、截图；需要更详细日志时用 `HARNESS_LOG_LEVEL=debug npm run dev` 启动（日志写 `~/.harness/logs/<YYYY-MM-DD>/`，目录 0700/文件 0600，不记录页面 URL、token、Prompt、原始帧或工具内容）。

## 18. 上下文压缩被跳过或失败

**症状/稳定码**：`/compact` 期间界面显示「正在压缩上下文」并禁止新输入（输入不排队，勿重复提交）；`context.updated` 事件的 `action` 字段区分结果；异常时 `Timed out waiting for context.compact` 或连续 `Unknown JSON-RPC response id`。

**按 action 处理**：

- `manual_skipped`：历史不足、无法构造最小摘要包装、没有完整 user/tool 原子组，或摘要后投影未严格减少。手动 `/compact` 只要求投影确实变小（不要求节省 20%）；明显无收益时不调用摘要模型。无需处理。
- `auto_skipped` / `overflow_skipped`：无可回收内容、自动熔断开启（自动连续三次失败后触发）或预计节省不足 20%。不是成功重写，上一份 latest-valid checkpoint 继续使用。
- `manual_failed` / `auto_failed`：摘要模型空结果、截断/结构错误、来源越界、投影膨胀或持久化校验失败；不留孤儿 Artifact、Summary 或 checkpoint。可重试或缩小上下文。
- `overflow_failed` 或 `CONTEXT_OVERFLOW_AFTER_RECOVERY`：已完成最多一次恢复重试；不要重复触发同一请求，缩短输入或开新 Thread。

若新版仍出现超时/未知响应 id：先确认 CLI 与 Python sidecar 同一构建，再保留脱敏 stderr 与终端截图排查。压缩期间不接受新消息；压缩成功后 Todo、审批/执行模式与 RunContextSnapshot 来自真实结构化状态，不从摘要文字猜测。

**禁止**：压缩期间重复提交 `/compact`；把摘要正文、工具参数、凭据或 AGENTS/Skill 内容写进日志。压缩失败不会伪装成功，也不会删除完整 Transcript（见 `~/.harness/threads.sqlite3`）。

## 19. Runtime Pool 容量不足或关闭超时

**症状/稳定码**：`RUNTIME_POOL_CAPACITY_EXHAUSTED`（Run 受理失败）；退出日志 `AgentEngine close timed out`。

**先检查**：`config show` 输出的 `runtime_pool_diagnostics`——Pool 大小、活跃 lease/run、命中/未命中、构建与关闭累计耗时、淘汰原因、关闭失败及最近生命周期事件。`memory.status=not_collected` 是预期（当前不采集不稳定 RSS）；排障先看 AgentEngine 数量、淘汰与关闭结果。`profile_id` 只是短诊断标识，不能推导模型或会话内容。

**安全恢复**：

- `RUNTIME_POOL_CAPACITY_EXHAUSTED`：所有已有 AgentEngine 正在执行/租用/固定，sidecar 不会中断它们。等当前任务完成后重试，或在用户级 `[runtime_pool]` 适度调大 `max_profiles`（默认 8，范围 1–64；`close_timeout_seconds` 默认 15，范围 1–120）。`max_profiles`/`close_timeout_seconds` 属 restart 级配置，改后需重启。
- `close timed out`：某 AgentEngine 资源关闭超过 `close_timeout_seconds`。**不会删除 SQLite 中的 Thread 数据**，重启后可恢复会话。先检查未响应的工具、Sandbox 或 MCP 连接，再按需调大该值（上限 120 秒）。

**禁止**：把完整 Prompt、模型凭据或企业路径写进诊断日志；为容量把 `max_profiles` 顶到 64 而不看机器资源。

## 20. 使用本地诊断日志排查故障

**日志位置（当前实现）**：交互式 CLI 与 Python sidecar 分别在 `~/.harness/logs/<YYYY-MM-DD>/`（Windows `%USERPROFILE%\.harness\logs\<YYYY-MM-DD>\`）写 `.active.jsonl`，正常关闭/轮转后为 `.jsonl`。默认保留 14 天、总量 200 MiB、单文件 16 MiB，只有关闭的文件参与清理。`~/.harness/debug` 是旧文档过期说法，当前代码不使用。`[diagnostics]` 的 `level/retention_days/max_total_mib/max_file_mib` 与临时 `HARNESS_LOG_LEVEL` 重启生效；任何级别都不记录 Prompt、模型正文、源码、完整工具入参/结果、凭据、绝对工作区路径或原始 RPC 帧。

**离线查询**（不启动 sidecar、不访问 SQLite、查询本身不写日志）：

```bash
npm run dev -- logs                                   # 最近 20 个 Thread
npm run dev -- logs --thread <id-or-prefix>           # 过程树 + 失败点与最慢前 5 项
npm run dev -- logs --run <run-id-or-prefix>          # 单次 Run
npm run dev -- logs --thread <prefix> --level warn --flat --limit 50
npm run dev -- logs --thread <prefix> --flat --cursor <token>   # 续页
npm run dev -- logs --run <prefix> --json             # 机器输出
```

- `--thread` 与 `--run` 互斥；`--level debug|info|warn|error`、`--event`、`--component` 按 AND 过滤；`--limit` 1–1000。
- `--flat` 必须配 `--thread` 或 `--run`，与 `--json` 互斥；`--cursor` 需配 `--flat` 或 `--json`；选择 Thread/Run 时默认每页 200 条。
- 续页错误码：`CURSOR_EXPIRED`（日志快照变化，重新查询即可）；`CURSOR_MISMATCH`（cursor 与工作区/选择器/过滤不符，用原始条件重查）。`LOG_ROOT_UNREADABLE`（日志目录不可读）；`QUERY_OUTPUT_TOO_LARGE`（缩小范围或加过滤）。

**临时 DEBUG**：`HARNESS_LOG_LEVEL=debug npm run dev` 复现问题后恢复。对外发送诊断前仍应复查是否含企业专有敏感命名。

**禁止**：清理日志时误删仍在写的 `.active.jsonl`；把 `--json` 原始输出未经检视直接发给第三方。

---

## 来源与维护锚点

- Plugin CLI parser（无 fingerprint flag）、staging/registry、错误码：`packages/cli/src/args.ts`、`packages/cli/tests/args.test.ts`、`packages/cli/tests/hc175-plugins.test.ts`、`packages/agent/harness_agent/plugins/store.py`、`manager.py`、`common.py`、Adapter 刷新行为测试 `packages/agent/tests/test_plugin_refresh.py`、Qwen Hook `packages/agent/harness_agent/plugins/qwen.py`。
- Provider 终态码与 Snapshot 错误码：`packages/agent/harness_agent/tools/snapshot_file_support.py`、`snapshot_file_schema.py`、host 模型请求路径（`host/agent_host.py`）。
- Thread 迁移与恢复：`packages/agent/harness_agent/threads/migration_recovery.py`、`migration_worker.py`、`thread_persistence.py`。
- 压缩 action 与 Runtime Pool：`packages/agent/harness_agent/threads/context_compaction.py`、`config/config.py`（`AgentEnginePoolSettings`、restart 级字段 `config/config_change_service.py`）。
- Web 接管参数、日志路径与查询：`packages/cli/src/presentation-coordinator/coordinator.ts`（65s/60s/10s）、`packages/cli/src/diagnostic-log/runtime/index.ts`、`query.ts`、`packages/agent/harness_agent/diagnostic_log/runtime.py`。
- 终端装饰阈值：`packages/cli/src/interactive/runtime.ts`（`supportsHomeDecoration` 88×28）。
- 历史对照（部分内容已过期，勿照抄）：`docs/user/故障排查.md`。
