---
id: HC-216
title: 每轮Token用量
feature_area: 会话用量与可观测性
parent_task: -
decomposed_by: Codex
priority: P1
status: 待验收
owner: Codex
branch: feat_hc_194_每轮Token用量
scope: 在 /web 每轮 Agent 回答下展示并持久化输入与输出 Token；按验收反馈统一对话和轨迹的权威总耗时，刷新和重新打开后可恢复。
acceptance: 每轮输入输出 Token 正确汇总、未知明确；对话和轨迹共享包含准备阶段的冻结总耗时；历史恢复一致。
user_docs: docs/user/Web界面.md
developer_docs: docs/developer/spec/HC-216-每轮Token用量.md、docs/developer/plan/HC-216-每轮Token用量.md、docs/developer/todo/HC-216-每轮Token用量.md、docs/developer/architecture/架构总览.md、docs/developer/architecture/上下文管理顶层设计.md
test_evidence: 停点 B：Python 同步 104 passed、147 deselected；CLI focused 121 passed；project:check、typecheck、build 通过；原生异步/人工验证限制见正文
references: docs/developer/task/HC-215-Web历史轮次分叉.md、docs/developer/task/HC-214-链路日志完整采集.md
completed_at: -
---

# 每轮 Token 用量

## 问题与用户结果

用户希望在 `/web` 的每轮 Agent 回答下看到该轮输入、输出 Token 数，并留下可恢复的记录。截图用于参考回答底部的展示位置，本期不引入价格计算。

输入 → 执行该轮模型调用并收集供应商返回的用量 → 汇总并持久化 → 在对应回答底部展示「输入 12,345 · 输出 678 Token」。

本功能可以独立于 Fork 使用和验收，因此单独维护 Task；两者共享回答底部空间，实施时保持布局一致。

## 统计口径

2026-11-10，用户明确确认：每轮用量包含子代理和上下文压缩产生的模型调用。

- 一轮指一次用户请求及其完整 Agent 执行，不是最后一次模型调用。
- 汇总本轮所有模型调用，包括工具往返导致的多次调用；子代理与上下文压缩若属于该轮执行，也计入一次，禁止父子重复累计。
- 采用供应商报告的实际输入、输出用量；输入本身包括历史上下文，不能用当前用户文本长度代替。缓存明细不再次加到输入总量。
- 输出按供应商报告口径，不用可见回答长度估算。错误、取消前已收到的用量仍记录，存在未报告部分时标记「统计不完整」。
- 缺失用量显示「未知」或「统计不完整」，真实零显示 0；不得用零伪装缺失值。
- 展示精确整数并使用千位分隔。运行结束后显示最终汇总；实时累计不是本期必需。
- 刷新、重启、重新打开会话后保持一致。旧历史没有记录时显示未知，不发起模型请求补算。
- Fork 继承的历史回答保留原轮用量作为历史展示，新分支新增轮次独立记账，不将继承历史算作新发生的调用。

## 可观察验收

1. 单次调用报告输入 100、输出 20，对应回答显示输入 100、输出 20。
2. 同轮两次调用分别为 100/20、150/30，显示 250/50；重复事件、恢复事件不重复累计。
3. 两轮用量分别挂在各自回答下，互不串轮；历史恢复数值一致。
4. 工具、子代理、压缩参与时符合统一口径，使用 mock 用量验证计数，不调用真实模型。
5. 无用量、部分用量、真实零、失败及取消均能区分；历史恢复保留完整性标志。
6. 展示与复制、Fork 按钮并存，不挤坏窄屏布局，具备可访问文本。

## 范围与后续阶段

不包含费用、账户账单、每日统计或供应商计费核对。Trace 可用于诊断，但页面及持久化用量不能依赖可关闭或可清理的日志文件。HC-214 的埋点需与本任务复用统计来源，不能另造相互矛盾的计数。

当前阶段：用户已确认 Task/Spec/Plan/Todo，并要求继续后续开发；停点 B 代码已完成，等待用户验收。HC-215 Fork 尚未实施；本任务未归档，不冒充整任务完成。

交付文档：[Spec](../spec/HC-216-每轮Token用量.md)、[Plan](../plan/HC-216-每轮Token用量.md)、[Todo](../todo/HC-216-每轮Token用量.md)。Spec Skill 经用户豁免，计划与实现使用仓库内置 planning-and-task-breakdown/test-driven-development。

## 停点 A 交付与证据

### A 验收反馈：统一本轮总耗时

用户截图指出对话 2.6s、轨迹 ROOT 2764ms、分组 2766ms 不一致，并明确确认：两处共用权威值，包含准备阶段，截止到结果完成、进入终态保存时，后台资源收尾单独记录。作为当前停点的验收修正，先更新 Spec/Plan/Todo 后实施，不推进 B 或 Fork。

验收：对话、Trace ROOT 行和分组显示同一冻结值及同一格式；刷新后从历史摘要恢复相同耗时；保存/释放耗时不再让已完成数值增长；模型/工具/DB 子节点仍保留各自计时。旧记录缺少权威值时显示未记录，不根据包络猜测。

修正已实现：RunTimingLedger 从受理入口计时并在终态保存前冻结；事件、RunCompletion、历史摘要和根 Trace 元数据共用同值。协议更新为 v3 minor 11，UI 仍 v11，SQLite 表结构仍 v21。先观察 ledger 缺少冻结方法、终态未传同值及 Trace 分组误用 9999ms 的失败，再实现。

修正验证：Python 本次计时/事务/用量/协议同步回归 34 passed、1 async deselected；CLI Trace/Timeline/历史状态/协议 131 passed。typecheck、project:check、build 通过。后台保存/收尾模拟推进 15 秒后总耗时仍为 2764ms，完成/失败/取消均覆盖；对话与 Trace 显示同为 2.8s，子模型仍为 2262ms。实际新一轮浏览器联调待用户查看，沙箱异步限制不变。Review 按既有 code-review-and-quality 维度复核，无新增阻断项；未提交、未推进 B/Fork。

- 当前分支 feat_hc_194_每轮Token用量，owner 为 Codex。缓存字段遗漏已由用户确认修订并解除阻塞；输入包含缓存，不再相加。
- 普通 Build 的模型 callback 按请求去重汇总；工具往返多次调用相加；失败/取消保留已知小计，未知与零区分。输出回滚不抹掉已发生请求，终态冻结拒绝迟到修改。网关适配器显式开启 stream_usage，请求最终用量块；新增不联网工厂回归先失败（库默认 None）再修复。
- Run binding 保存 terminal_summary，SQLite v21；完成/失败/取消发送同一份已保存统计。写库失败转失败终态；摘要更新有 CAS 条件，冲突不覆盖。旧记录保持未知。
- Agent Protocol v3 minor 11 与内部 UI v11；实时和历史保留 run_id/record_id，Core 保存逐轮摘要。Web 最终回答的复制按钮旁显示用量，状态面板保留缓存命中且未知不伪造成零。
- TDD 已记录收集器模块缺失、缓存缺失、逐轮 UI 空结果、回滚丢计数、方向冲突和 schema 完整标记矛盾等失败，再实现通过。
- Python：node scripts/dependencies/run_python.mjs -m pytest -q packages/agent/tests/extensions/test_gateway_usage.py packages/agent/tests/runtime/test_run_usage.py packages/agent/tests/threads/test_run_usage_store.py packages/agent/tests/runtime/test_execution_stream.py packages/agent/tests/protocol/test_protocol_contract.py -k 'not async and not execute' --basetemp=tmp/pytest-hc194-verified，39 passed、9 deselected。包括真实 LangChain 同步 callback、生产 execute 的立即完成 fake、真实同步 SQLite SQL/回滚与终态观察顺序；不是实际异步集成。
- CLI：interactive、web/presentation、presentation-shared 中除 Git 宿主测试和已有 styles.test.ts 外的 73 文件，614 passed。另一个包含 state/thread/goal/run/Timeline/adapter/UI-contract/IPC-contract 的 focused 命令 237 passed（与前者重叠，不相加）。
- npm run project:check、npm run typecheck、npm run build 通过。构建最初因 Bun 读取 D:/code 被沙箱拒绝，已获授权在沙箱外构建并通过。Python 修改文件 compileall 通过。
- 限制：Python 异步测试在 asyncio 初始化 socketpair/accept 卡住，按仓库规范跳过，未申请出沙箱；新增真实 v20→v21 升级/重开回归待宿主验证。未运行完整 npm test，未启动真实 /web 做模型/浏览器联调，也未生成实际页面截图。Node/Bun 受控 DOM 测试验证逐轮文本及操作行；人工窄屏、刷新和真实供应商展示待用户查看。
- 扩大检查曾遇到已有几何样式断言 2 项失败（与本次 footer 新增样式无关）及 Git 宿主测试失败；保留现有用户布局，不为其改写断言。新历史摘要契约导致的 Goal/计划等测试夹具已迁移并验证通过。

## 停点 A review（code-review-and-quality）

按正确性、可读性、架构、安全、性能复核本任务增量：普通路径未发现阻断问题。已移除跨模型轮次取最大值的旧统计路径，CLI 不累加日志；SQL 参数化、schema 拒绝非法计数及完整标记矛盾。保留缓存能力，回调线程加锁并按方向记录冲突，摘要事务写入失败不发完成。未更换既有执行生命周期；child/压缩归属和取消收拢属于 B，不能提前宣称全路径完整。

版本影响：未修改 VERSION、包 SemVer 或 CHANGELOG；内部协议、UI 与 SQLite 形状如上已同步。未提交、无 PR；保留工作区 HC-192 等已有改动。用户文档和既有架构已增量更新。OpenWiki 命令在本机不可用，未手改生成页。

## 用户查看方式

重启 npm run dev，进入会话执行 /web；普通 Build 连续发两轮消息，查看各轮最终回答下的输入/输出 Token，然后刷新或重新打开会话。供应商未报告用量应显示未知。只验证此停点，用户查看后再继续 B；不自动实施 Fork。

## 停点 B 交付与 review

- start 准备阶段和受理后的 RunState 共享同一收集器，异常/返回时 reset ContextVar；完整压缩显式传 callback，独立压缩不污染旧轮次。Inline child 与 Managed grandchild 使用现有执行入口归集实际模型请求，父工具结果不再作为调用计数。
- 修复父任务在 asyncio.wait 处被直接取消时没有取消/收拢 runner 的缺口。finally 对 runner 与取消监听统一 gather；timeout、取消 token 与父取消均在返回前收拢。既有超时/错误码、slot 与 lease 归属不变。
- Trace 根 usage 和命中率直接取 RunCompletion；缺失/不完整保持 null 或小计，不从 Trace 自己的 span 统计重算。UI 子时间线不重复显示整轮总数。
- TDD：准备阶段 collector 为 None、摘要未显式接入、父取消遗留 runner、Trace 根仍用独立空统计均先观察失败，再修复。组合 mock 为主调用两次 100/20 + 100/20、Inline child 100/20、Managed grandchild 150/30、压缩 50/5，最终 500/95；持久化恢复和 Trace 根一致。
- Python：node scripts/dependencies/run_python.mjs -m pytest -q packages/agent/tests/runtime/test_run_usage_nested.py packages/agent/tests/runtime/test_run_usage.py packages/agent/tests/threads/test_run_usage_store.py packages/agent/tests/host/test_run_duration.py packages/agent/tests/runtime/test_execution_stream.py packages/agent/tests/threads/test_context_compaction.py packages/agent/tests/runtime/test_managed_agent_executor.py packages/agent/tests/test_agent_delegation.py packages/agent/tests/host/test_run_coordinator.py -k 'not async' --basetemp=tmp/pytest-hc194-b-verified：104 passed、147 deselected。
- CLI：Timeline、state、ThreadFeature、usage contract、TraceView 五文件 121 passed。project:check/typecheck/build 通过。无真实模型凭据、无网络模型调用。
- 限制：原生 asyncio 的 socketpair 沙箱限制依旧，147 个异步测试跳过；新增真实并发父取消回归也未运行。同步测试使用无 IO graph fake 和 SQLite 驱动，不能等同于真实并发或浏览器验收。未跑完整 npm test、真实供应商/实际浏览器场景，未生成新的浏览器截图；仍需用户宿主验收。
- 按 code-review-and-quality 五维自查：统计单一事实源、请求身份去重、根绑定正确 reset，取消先收拢再冻结；不新增协议/SQLite/UI 版本，不保存新正文或秘密。未发现本停点的新增阻断项。用户文档与既有架构已更新。
- 未提交、无 PR，VERSION/包版本/CHANGELOG 未变；保留所有其他任务未提交改动。OpenWiki 命令不可用，未手改生成页。待用户查看后再完成验证、提交/归档；不在此停点自动开始 Fork。

查看：重启 npm run dev → /web，发起需要子代理的任务，核对最终回答用量与 Trace 根 usage。自动完整压缩触发时其模型用量计入本轮；独立 /compact 不回写上一轮。受控精确数值可运行 test_run_usage_nested.py 中的组合回归验证。
