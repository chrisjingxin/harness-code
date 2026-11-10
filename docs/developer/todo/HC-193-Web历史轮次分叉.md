---
id: HC-193
title: Web历史轮次分叉
plan: docs/developer/plan/HC-193-Web历史轮次分叉.md
status: 已确认
---

# Web 历史轮次分叉执行清单

依据 [Spec](../spec/HC-193-Web历史轮次分叉.md) 与 [Plan](../plan/HC-193-Web历史轮次分叉.md)。Plan/Todo 待确认，执行按 TDD，一次只推进下一可演示停点。

## 开工

- [ ] 确认 HC-194 已交付的轮次摘要和当前 schema 版本；git status --short 保留其他改动，task:claim 在本 Task 分支登记 owner/branch。
- [ ] 使用内置 test-driven-development，只执行停点 A，未确认的设计冲突回写 Spec。

## 停点 A：普通历史回答可分叉并继续

- [ ] A1 新增 threads 分叉服务及 test_thread_fork.py：三轮截第二轮、同文回答精确命中、最终主回答校验、工具调用配对、原历史不变。先失败再实现，focused pytest 通过。
- [ ] A1 历史复制生成新 record ID 并保存来源映射；artifact 复制并重写引用，不使用源当前 checkpoint。缺失引用失败测试通过。
- [ ] A2 ThreadPersistence 事务保存 Thread/历史/artifact/摘要/来源；注入中途失败无空壳，重读历史独立。focused persistence/fork tests 通过。
- [ ] A2 同 target 同来源幂等、不同来源冲突；run.start/undo/delete 与分叉共享互斥，新增忙碌与竞态测试通过。
- [ ] A2 新会话 Build 状态无 Goal/Compose/审批/Snapshot/撤销状态；删除源后仍可读取。对应 focused tests 通过。
- [ ] A3 Protocol 注册 threads.fork 和 canonical 错误，生成两端类型/fixtures。npm run protocol:check 与两端合约 tests 通过。
- [ ] A3 SDK、AgentHost dispatch 和 gateway 贯通请求；实时/恢复都携带 record_id/run_id，历史摘要保持不变。请求输入与错误映射 tests 通过。
- [ ] A3 Interactive ThreadFeature 创建后打开，操作内 target ID 稳定；打开失败只重试打开，迟到结果不抢回选择。bun test tests/interactive/thread-feature.test.ts 通过。
- [ ] A4 WebUiGateway/adapter 契约升级并迁移；按钮仅成功主回答显示，busy/交互时禁用，重复点击防重。bun test tests/web/application/adapter.test.ts 与相关 gateway tests 通过。
- [ ] A4 Timeline 增加复制旁图标、提示和可访问名称；成功刷新列表并切换，新草稿为空、源草稿保留。bun test tests/web/presentation/timeline.test.tsx 通过。
- [ ] 跑 npm run typecheck、相关 focused tests，记录结果；截图展示按钮、busy 状态和新会话。
- [ ] 演示：npm run dev → /web 三轮对话 → 第二轮 Fork → 新会话只有前两轮 → 继续提问 → 重开原会话仍三轮，刷新新会话可恢复。
- [ ] 更新 Task 证据、Todo 勾选和 tmp/handoff.md；标明复杂历史验收仍待 B；停止等用户查看。

## 停点 B：复杂历史与异常恢复（用户要求继续后）

- [ ] B1 验证分叉点后压缩摘要不进入新请求，点前 artifact 内容独立可读；新 mock 模型输入断言无点后独有事实，focused fork/context_projection tests 通过。
- [ ] B1 工具多调用配对、child 输出无分叉入口；缺少规范历史明确 history-unavailable，不能以最新状态补缺。focused tests 通过。
- [ ] B2 从继承回答再次分叉，来源映射与用量摘要保留；新轮独立统计。fork/thread-feature/Timeline tests 通过。
- [ ] B2 断线重试同 target、冲突、双击、创建后打开失败和用户切换迟到响应测试通过，无重复建会话。
- [ ] B3 自动验证分叉不写工作区文件、不改 HEAD/index、不继承文件 Snapshot；已有 undo/redo 和审批邻近回归通过。
- [ ] 演示复杂历史分叉、刷新、再次分叉，核对原会话与用量；附截图，记录已知历史不可恢复错误。
- [ ] 更新 docs/user/Web界面.md 与既有会话/上下文架构及架构总览；OpenWiki 可用则刷新，否则记录缺失。
- [ ] npm run project:check、npm run typecheck、npm run test、npm run build 通过；sandbox 禁止宿主测试记录跳过，其余失败解决或阻塞。
- [ ] 使用 code-review-and-quality review，结论、版本未变和关联提交写回 Task；只提交本 Task 范围。
- [ ] 用户验收且完成定义齐全后执行 task:complete，归档、同步看板并更新 tmp/handoff.md。

