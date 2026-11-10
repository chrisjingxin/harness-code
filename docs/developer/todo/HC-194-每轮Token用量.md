---
id: HC-194
title: 每轮Token用量
plan: docs/developer/plan/HC-194-每轮Token用量.md
status: 已确认
---

# 每轮 Token 用量执行清单

依据 [Spec](../spec/HC-194-每轮Token用量.md) 与 [Plan](../plan/HC-194-每轮Token用量.md)。用户已确认 Spec 和 Plan/Todo；本轮执行至 A，B 不推进。每个执行项先失败测试再最小实现；未实施不得勾选。

## 开工

- [x] 运行 git status --short，保留其他任务改动；通过 task:claim 在 HC-194 对应分支登记 owner/branch。不把 HC-192 改动夹入提交。
- [x] 使用仓库内置 test-driven-development；仅执行下面停点 A。遇到 Spec 冲突停止回写，不扩范围。

## 停点 A：普通对话逐轮可见，刷新可恢复

- [x] A1 新增 runtime 用量收集器与失败测试：两次请求 100/20+150/30 得 250/50；重复回调只计一次；累计 chunk 不重复累加，null 与零区分。focused pytest 新用量模块测试通过。
- [x] A1 缓存明细不再次加到输入，全部已知才提供 cached_tokens；缓存缺失/部分/零值回归测试通过。
- [x] A1 主模型调用边界生成 invocation 身份并登记已发起请求；覆盖重试、单向缺失与冲突最终值，断言完整性正确；focused pytest 调用适配测试通过。
- [x] A2 ThreadPersistence 保存 Usage 四字段并与 Run 终态同事务；旧记录未知，重读与终态一致。同步 SQLite 事务/恢复测试通过；真实数据库升级重开测试已补齐，异步运行因沙箱 socketpair 限制跳过。
- [x] A2 RunCoordinator 完成/失败/取消收拢调用后冻结统计；写库失败不发送成功，晚到回调不修改终态。同步终态测试验证持久化先于通知及写入失败；原异步生命周期回归因沙箱限制跳过。
- [x] A3 改 Protocol canonical schema，生成全部两端产物和 fixtures，终态与 threads.open.run_summaries 统一 Usage。npm run protocol:check 通过；无旧 Usage fallback。
- [x] A3 SDK 与 Host 恢复携带 run_id 和每轮摘要；mock 历史未知/零/部分已知与实时形状一致，两端合约 tests 通过。
- [x] A4 Interactive State 按 run_id 保存多轮摘要，重复通知覆盖；历史恢复、失败/取消无正文正确定位。packages/cli 下 bun test tests/interactive/state.test.ts tests/interactive/thread-feature.test.ts 通过。
- [x] A4 Timeline 回答底部格式化统计，窄屏换行、读屏标签和复制正文均符合 Spec。bun test tests/web/presentation/timeline.test.tsx 通过；TUI 邻近消费者类型检查无回归。
- [x] 执行 npm run typecheck、相关 focused tests，保存命令和结果；不把其他任务的失败归因于本功能。
- [ ] 演示：npm run dev → /web 发两轮问题，查看各轮统计并刷新；先用受控 mock 核对精确值。附页面截图，注明真实供应商可能不报告 usage。
- [x] 更新 Task 证据、上述勾选及 tmp/handoff.md，注明 child/压缩尚待 B；停止，等用户查看。不得继续下一节。

## 停点 B：子代理与压缩完整计入（用户要求继续后）

### 进入 B 前：A 验收反馈修正（本轮执行）

- [x] 先写失败测试：准备时间计入、终态值冻结、保存和释放不再改变总耗时；对话与 Trace ROOT/分组不再读三个计时源。
- [x] 使用同一 ledger 冻结值写事件、RunCompletion、历史摘要、Trace 根 run_duration_ms；更新两端 canonical schema 与恢复映射。
- [x] 统一对话和 Trace 的总耗时格式，原始采集耗时只在详情中区分；旧记录未知不猜测，子节点计时保持。
- [x] focused tests、协议检查、类型检查通过，更新文档/Task/中文交接后停止，等待用户查看；不执行以下 B1/B2。

- [x] B1 inline/managed child 实际请求共用 root 收集器；父委派不再计子汇总。两层 child、重试、错误/取消同步测试通过；原生异步 slot/lease 回归因沙箱限制待宿主补验。
- [x] B2 压缩模型调用归属触发 Run；微压缩无调用、独立压缩不倒算上一轮。test_context_compaction.py 同步回归与 test_run_usage_nested.py 摘要调用测试通过，估算长度不计作 usage。
- [x] B2 覆盖取消时已知小计和晚到回调，冻结值与恢复值相同；同步 coordinator/委派回归通过，新增原生异步父取消测试另列未运行。
- [x] B3 mock 跨层 Run 同时含工具往返、child、压缩，断言精确总量及单向不完整；恢复不累计第二次，断言通过。
- [ ] 演示：/web 执行受控复合场景，回答下核对总量并重开会话；补缺失/失败示例和截图。
- [x] 更新 docs/user/Web界面.md 与相关既有架构，不另起平行架构；OpenWiki 可用则刷新，不可用记录原因。
- [ ] 运行 npm run project:check、npm run typecheck、npm run test、npm run build；sandbox 禁止宿主测试记录跳过；其余失败解决或明确阻塞。
- [x] 使用 code-review-and-quality 复核 Task/Spec、diff 和测试，结论写入 Task；记录版本未变和验证。尚未提交；后续提交只包含本任务范围。
- [ ] 用户验收且完成定义全部满足后，以 task:complete 写证据并归档，同步看板，更新中文 tmp/handoff.md；不得提前标记完成。


停点 B 自动验证证据见 Task；完整 npm test、真实异步并发和人工演示项仍未勾选，不能提前归档。
