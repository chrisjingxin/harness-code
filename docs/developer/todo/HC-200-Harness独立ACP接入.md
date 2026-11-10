# HC-200：Harness独立ACP接入执行清单

来源：[Plan](../plan/HC-200-Harness独立ACP接入.md) / [Spec](../spec/HC-200-Harness独立ACP接入.md) / [Task](../task/HC-200-Harness独立ACP接入.md)。

规则：
- 每次只推进到下一个停点；到达停点后勾选本节、把证据写回 Task，然后停下等用户确认。
- 每个实现项都先写失败的测试。
- 每节末尾的门槛按 Plan「测试门槛」执行（G1 ACP 套件、G2 Host 套件、G3 测试客户端、G4 项目检查）。

状态：S0、S1 已完成（1.4、1.9 性能项经用户决定暂缓）；S2、S3 用户已确认通过。S4 已实现，待验收，不进入 S5。

## 停点 0：摸底（无可见变化）

查看方式：Task「S0 结论」一节的 8 项结论；Spec 如有修订，看修订记录。

- [x] 0.1 记录基线：`git status --short`；G1、G2、G3 各跑一次，记录通过数和已知失败。
- [x] 0.2 A 握手：写流水线三帧测试（先不修），记录现在的真实响应；更正 HC-209 相关记录的措辞。
- [x] 0.3 B 子代理：确认子代理事件能否定位到父 `task` 调用；不能的话写明 Host 补字段的位置。
- [x] 0.4 C 模型锁定：写明 `describe_thread_binding` 下什么状态不允许切换模型。（结论：没有锁定，见 Task「S0 结论」C）
- [x] 0.5 D Skill 命令：确认用户可调用的 Skill 能否进入命令快照并通过 `bind_commands` 校验。
- [x] 0.6 E 子命令拼写：列出 TUI 中 `/undo`、`/redo`、`/goal`、`/compose`、`/title`、`/btw`、`/compact` 的参数形式，修正 Spec §11.3。
- [x] 0.7 F 工具状态：确认 Transcript 是否已记录工具成功/失败；没有的话写明补记位置。（结论：已记录，只需读出，见 Task「S0 结论」F）
- [x] 0.8 G 有序下发：确认事件扇出与交互下发的路径，定下有序队列放在哪一层。
- [x] 0.9 H 会话 MCP：确认 `McpConnectionManager` 与 engine 指纹的接入点。
- [ ] 0.10 结论写入 Task，必要的 Spec 修订完成；有推翻决定的情况就停下请用户确认；G4；**停下等待用户确认**。

## 停点 1：协议底座与性能

查看方式：
1. `harness web --cwd <项目目录>` 打开页面，对比改前改后从打开到能输入的时间（测量脚本输出四段耗时）。
2. 侧栏会话显示消息条数和最近一句；会话超过 50 个时滚到底加载下一页。
3. `cd packages/agent && HARNESS_ECHO_MODE=1 .venv/bin/python -m harness_agent acp`，一次粘贴 `initialize`、`session/new`、`session/list` 三行，三个响应都出现。

- [x] 1.1 测量脚本：四段耗时（启动到 `initialize`、`session/new`、首个命令表、`session/list`），记录改前基线到 Task。
- [x] 1.1a 分层架构测试（Spec §4.2「代码位置」）：AST 扫描 import。一是 `host/acp/` 只能 import `harness_agent.host.*` 和 9 处白名单；二是除了 `host/acp/` 和 `__main__.py`，其他模块都不 import `acp` 或 `host.acp`。现状已满足，测试应当直接通过；再造一个违规样例，确认测试能把它拦下。
- [x] 1.2 握手闸门：0.2 的测试转为失败断言；实现 `_ready()`；补「未握手」「握手失败后排队请求」两个测试。测试用 `ensure_ready()` 带 0.3s 延迟的替身 Host 做确定性复现（见 Spec §6.1 S0 实测），参考 `tmp/hc200-s0/handshake_inprocess_probe.py`
- [x] 1.3 命令表总推送：new/load 后空表也推的测试；实现；测试客户端删除 `settleCommandsMs` 固定等待并补单测。
- [ ] 1.4（用户决定暂缓：Electron 包完成后再评估，见 Task「S1 结果」）`session/list` 提速：按测量脚本打点定位，优化，记录前后耗时（目标 ≤ 0.1s / 200 线程）。
- [x] 1.5 分页持久层：`list_threads_page(limit, after)` 的排序与边界测试（同 `updated_at_ms` 的多个线程）；实现。
- [x] 1.6 分页 ACP 层：游标编解码、三页无重复无遗漏、`INVALID_CURSOR`；删除「有游标回空」分支；`HostServicePort` 一致性测试同步。
- [x] 1.7 会话摘要：`ext.py` 的 `sessionSummary` 能力与出口函数；未声明时递归扫描无 `harnessCode`；Py/TS 能力名漂移测试。
- [x] 1.8 resume/close：能力声明；resume 不回放、跨连接 `THREAD_BUSY`；close 取消在途 Run、释放、幂等；各自测试。
- [ ] 1.9（用户决定暂缓并已回退惰性导入：见 Task「S1 结果」）惰性导入：`-X importtime` 分析记录到 Task；推迟重型模块；「`initialize` 后重型模块未导入」测试；「配置错误仍在 `initialize` 暴露」测试。
- [x] 1.10 测试客户端：会话侧栏翻页、条数与预览、声明 `sessionSummary`、刷新重连用 `session/resume`；各项单测。
- [x] 1.11 测量脚本跑改后数据写入 Task（5 次中位数；未达标写明瓶颈）；G1、G2、G3、G4；**停下等待用户确认**。

## 停点 2：工具卡保真

查看方式（`harness web`）：
1. 让 Agent 改一个已有文件：审批卡出现左右对比的 diff。
2. 让 Agent 跑一个会失败的命令，再刷新页面：恢复的工具卡显示参数和失败状态。
3. 让 Agent 调用子代理：子代理工具卡挂在父 `task` 卡下面，子代理的审批出现在它自己的卡上。

- [x] 2.1 事件顺序：200 次「正文 → 工具卡 → 审批」顺序测试先失败；按 0.8 结论实现有序下发。
- [x] 2.2 稳定 id（`ToolCallIdStore` 改 FIFO 队列，payload 每个 action 都带 id）：补齐缺 `tool_call_id` 的审批路径（批量后续动作、子代理、`execute`、MCP），每条路径一个测试。
- [x] 2.3 删除 `translate.py` 参数匹配降级；「审批先于工具卡时同 id 建卡、后续复用」测试；同名同参连续两次调用各一张卡的测试。
- [x] 2.4 v3 协议：`fileDiffPresentation` 新增 `old_text`/`new_text`，重新生成；v3 现有测试通过。
- [x] 2.5 `PreparedFileMutation` 写入全文（256 KiB 上限、二进制不带）的测试与实现。
- [x] 2.6 `permissions.py` 产出标准 `diff`（新建/删除/修改三种）；超限回退文本；帧大小测试。
- [x] 2.7 工作区外位置：`resolve_display_path()` 服务方法（Host 用注册表只读视图解析，见 Spec §7.5）；`PathLocator` 改走它；根内外各一个测试；分层测试豁免清空。
- [x] 2.8 回放字段：`threadMessage` tool 记录新增 `tool_call_id`/`arguments`/`status`（状态读自 Transcript 已有的 `status`，不补记），重新生成协议；Host 测试。
- [x] 2.9 `sessions.py` 回放带 `rawInput`、标题、kind、locations、真实状态；同一历史两次回放 id 一致；旧数据无状态按 `completed`。
- [x] 2.10 5000 条历史 `session/load` 耗时测量（记录，目标 ≤ 1.5s；未达标优化读取）。
- [x] 2.11 子代理：`subagent` 能力；子代理工具卡 id/标题/`parent`；正文累加进父卡（64 KiB 上限）；子代理审批挂卡；未声明时无 `parent` 字段；父卡关系来自 `tool.delta` 的 `child_execution_id` 绑定（Spec §7.3），不改 Host 事件信封。
- [x] 2.12 测试客户端：渲染标准 `diff`；回放卡参数与失败状态；子代理卡挂在父卡下；声明 `subagent`；各项单测。
- [x] 2.13 G1、G2、G3、G4；人工按查看方式操作一遍；证据写入 Task；**停下等待用户确认**。

## 停点 3：人工交互

查看方式（`harness web`）：
1. 发「先问我用哪种方案再动手」：出现提问卡，选择后 Agent 按回答继续。
2. 切到「先出计划」模式发任务：出现计划确认卡；批准后模式下拉自动切回原模式。
3. 审批时选「拒绝并说明原因」并填写：Agent 下一句回复体现这条原因。
4. `/goal` 在 S5 才宣告；本停点用脚本化测试验证 Goal 确认表单。

- [x] 3.1 新建 `elicitation.py`：表单发送、回答解析、待回答表、`$/cancel_request` 撤回、迟到回答丢弃；按 `elicitation.form` 启用；SDK 版本锁定测试。
- [x] 3.2 Run 取消 / 连接断开时待回答表单按「取消」交还 Host 的测试。
- [x] 3.3 提问：schema 形状快照（单选、多选、其他、多个问题）；accept/decline/cancel 映射；属性名用序号的测试。
- [x] 3.4 Host：连接不支持提问时，提问工具向模型返回明确错误（不再是空答案）。
- [x] 3.5 拒绝附反馈：选项按能力出现；选中后的追问表单；accept 带文本、decline/cancel 退回普通拒绝。
- [x] 3.6 计划：`modes.py` 按能力暴露 `plan`，不支持时 `UNKNOWN_MODE`；计划表单（决策只列 payload 中有的、markdown 16 KiB 截断）。
- [x] 3.7 模式回流：v3 新增 `thread.approval_mode` 通知并生成；Host 三个来源广播；`AcpServer` 去重后发 `current_mode_update`；`set_mode` 自身只发一次。
- [x] 3.8 Goal：表单与 `edited` 判定条件切分（空、超过 32 条的边界）；`goal` 能力；判定条件 → 标准 `plan` 更新；Compose 进行中时不发 Goal 的 `plan`。
- [x] 3.9 审批扩展：选项 `scope`；`requests` 与 256 KiB 截断；未声明时不出现。
- [x] 3.10 测试客户端：新建 `elicitation.ts`，四种表单识别接入已有卡片，认不出的走通用表单；声明 `elicitation.form`、`goal`；各项单测。
- [x] 3.11 G1、G2、G3、G4；人工按查看方式操作一遍；证据写入 Task；**停下等待用户确认**。

## 停点 4：会话配置与输入

查看方式（`harness web`）：
1. 模型下拉切换后发消息：Run 摘要里的模型是新选的。
2. 切到「分阶段协作」发任务：出现 Compose 阶段条并随进度变化。
3. 连续对话：上下文用量数字增长。
4. 输入 `@某文件 解释一下`：第一轮回复直接引用文件内容，没有先调用读文件工具。
5. 用脚本化 SDK 客户端传 `additionalDirectories` 和 `mcpServers`（测试中验证；浏览器不涉及）。

- [x] 4.1 服务面：抽取 `list_models`，新增 `set_session_roots`、`set_session_mcp`；`HostServicePort` 一致性测试；G2。待验收。
- [x] 4.2 新建 `config.py`：`model`/`workflow` 两项的构造；模型目录为空时不出现 `model`；new/load/resume 响应带 `configOptions`；`open_connection` 能力加 `models.select`。待验收。
- [x] 4.3 `session/set_config_option`：影响下一轮 `requested_primary_profile` / `mode`；Run 中修改只影响下一轮；`UNKNOWN_CONFIG_OPTION`、`INVALID_CONFIG_VALUE`；变化推 `config_option_update`。待验收。
- [x] 4.4 Compose：`compose.progress` → `plan` 状态映射（含失败）；`compose.summary` → 消息块。待验收。
- [x] 4.5 用量：`usage_update` 字段齐全才发、相同值不重复；`PromptResponse.usage` 映射。待验收。
- [x] 4.6 附加目录：绝对/存在/目录/可信四种拒绝；整单拒绝带 `data.path`；`session` 作用域登记；load/resume 替换；close 撤销；诊断不含原始路径。待验收。
- [x] 4.7 会话 MCP：按 0.9 结论接入；stdio/http 生效；sse 与同名跳过并记诊断；诊断不含 command/env/headers；连接失败不影响会话创建。待验收。
- [x] 4.8 文件内联：`resource_link` 根内读取、根外保持文本；`resource` text 内联、blob 报错；10 KB/20 KB 预算；Transcript 只记原文；`initialize` 声明 `embeddedContext`。待验收。
- [x] 4.9 Py/TS 附件块格式漂移测试（对照 `mention-resolver.ts`）。待验收。
- [x] 4.10 测试客户端：模型与工作模式接 `configOptions`；用量接 `usage_update`；阶段条接 `plan`；`@文件` 发 `resource_link`；各项单测。待验收。
- [x] 4.11 G1、G2、G3、G4；人工按查看方式操作一遍；证据写入 Task；**停下等待用户确认**。待验收。

## 停点 5：内置命令

查看方式（`harness web`）：
1. 输入 `/`：看到 `compact`、`btw`、`undo`、`redo`、`title`、`goal`、`abandon` 和 `skill:xxx`。
2. `/btw 这个项目用什么测试框架`：答案以旁注样式出现，刷新后不在历史里。
3. 改一个文件后 `/undo`：文件恢复，时间线自动刷新；`/redo` 恢复。
4. `/title 新名字`：侧栏标题立即变化。
5. `/compact`：显示压缩前后 token 数，用量指示同步下降。
6. `/goal 目标`：出现 Goal 确认卡；`/goal pause` 等子命令有回复。

- [ ] 5.1 服务面：抽取 `compact_thread`、`side_question`、`undo_thread`、`redo_thread`、`list_turns`、`set_thread_title`、`goal_inspect`、`goal_request`、`goal_mutate`、`compose_abandon`；v3 处理器变薄壳；AST 禁令测试覆盖新方法；每抽一个跑 G2。
- [ ] 5.2 命令拦截：内置命令表按能力筛选；冲突规则（内置 > Plugin > Skill）与诊断；拦截后不启动 Run、不写 Transcript；结果消息块 id。
- [ ] 5.3 `/compact`：成功（补发 `usage_update`）、线程忙。
- [ ] 5.4 `/btw`：成功（`ephemeral`、不入历史）、缺参数。
- [ ] 5.5 `/undo`、`/redo`：成功（`historyChanged`）、`NOTHING_TO_UNDO`、非 Git 仓库、`THREAD_NOT_IN_REVERTED_STATE`。
- [ ] 5.6 `/title`：成功（`session_info_update`）、缺参数。
- [ ] 5.7 `/goal` 的 inspect/创建/`pause|resume|clear`/`edit` 形式与 `/abandon`：成功与失败各一个；不支持表单时 `/goal` 不宣告。
- [ ] 5.8 Skill 命令：Host 命令快照纳入用户可调用 Skill（按 0.5 结论）；删除 `/skill:` 限制；`skill:x` 调用成功。
- [ ] 5.9 `commands` 能力：命令来源字段、命令响应 `_meta.harnessCode.command`；catalog 变化后向所有会话重发。
- [ ] 5.10 测试客户端：命令表整表替换；`historyChanged` 重新 `session/load`；`ephemeral` 旁注样式；声明 `commands`；各项单测。
- [ ] 5.11 G1、G2、G3、G4；人工按查看方式操作一遍；证据写入 Task；**停下等待用户确认**。

## 停点 6：收尾

查看方式：`docs/developer/architecture/ACP通信.md` 缺口表；Task 验收项与证据。

- [ ] 6.1 官方 Python SDK 端到端测试两种：不声明扩展、声明 `elicitation.form`；走通新建 → 提问回答 → 计划确认 → 切模型 → 取消 → resume。
- [ ] 6.1a 按 Agent 接入架构 §6 的测试项整理 Harness 能力矩阵，填入该文 §4.2 表格的 Harness 一行。
- [ ] 6.2 缺口表 28 行逐行改「已关闭」并附测试证据；未完成的写原因交用户决定。
- [ ] 6.3 `ACP通信.md`：方法表、扩展能力表、新模块、UNSTABLE 依赖、性能基线实测值。
- [ ] 6.4 用户文档：`Web界面.md`、`快速开始.md`、`安全与沙箱.md`。
- [ ] 6.5 真实模型手工冒烟：S1～S5 查看方式逐项操作，记录写入 Task（与 mock 自动化证据分开记）。
- [ ] 6.6 Task 验收项逐条更新；依赖 HC-197/196 的两项保持未勾选并注明；「去掉扩展仍可完整走通」一项以 6.1 不声明扩展的端到端测试为证据。
- [ ] 6.7 G1、G2、G3、G4；**停下等待用户确认**。

## 停点 7：原有功能覆盖核对

查看方式：`docs/developer/architecture/ACP通信.md` 的「原有功能覆盖矩阵」一节和缺口表新增行。

- [ ] 7.1 从代码列出 TUI 斜杠命令与快捷键。
- [ ] 7.2 从代码列出 TUI 与旧 `/web` 的界面操作（对话、侧栏、设置、Trace、文件/Git、弹窗）。
- [ ] 7.3 列出 v3 方法与通知、交互类型、Run 模式、影响会话行为的命令行参数与配置项。
- [ ] 7.4 逐项判定覆盖状态：已覆盖附证据；未覆盖按 Agent 接入架构 §3 的顺序（标准 → 协议兼容 → 上移到平台 → Harness 扩展或斜杠命令 → 不支持）给出去向并标明所属层。
- [ ] 7.5 写入覆盖矩阵；未覆盖项登记为缺口表新行；需要新任务的只列建议。
- [ ] 7.6 写出结论：TUI 能否在功能上被 ACP 链路替代、还差哪几项；Task 对应验收项更新。
- [ ] 7.7 G4；`openwiki code --update --print`；Task 状态改「待验收」；**停下等待用户确认**。
