---
id: HC-215
title: Web历史轮次分叉
spec: docs/developer/spec/HC-215-Web历史轮次分叉.md
status: 已确认
---

# Web 历史轮次分叉实施计划

需求见 [Task](../task/HC-215-Web历史轮次分叉.md)，行为见 [已确认 Spec](../spec/HC-215-Web历史轮次分叉.md)，执行见 [Todo](../todo/HC-215-Web历史轮次分叉.md)。

## 依赖与实施边界

推荐在 HC-194 完成后实施，复用稳定 Run 摘要。Fork 自身必须补齐持久化 record_id 与最终回答身份；不可拿 UI 索引做截止点。所有行为以 Spec 为准，以下不另增模式选择或文件恢复。

每步按 TDD，先验证新行为失败再实现。每停点是可运行的纵向结果，内部前置步骤不能作为单独用户交付。已有 HC-192 改动保持不变。

## 停点 A：从普通历史回答创建新会话并继续

### A1 独立历史构建（无依赖，中等）

新增 threads 内分叉服务，将目标记录校验、截止前历史复制、记录身份与来源映射放在独立职责模块。规范 transcript 是唯一来源；复制过程中验证成功主回答和工具配对。复制需要的 artifact 并重写引用，不能复制源最新 checkpoint。

邻近文件：新分叉模块与测试、threads/thread_records.py。验收：三轮截到第二轮，原记录不变；同文回答仍精确命中；不完整历史失败。

### A2 事务与会话并发（依赖 A1，中等）

ThreadPersistence 原子保存新 Thread、历史、artifact、来源与继承摘要；target ID 和来源建立幂等校验。与 run.start、撤销和删除复用会话互斥，busy 检查在锁内完成。新会话全新 Build 状态，不复制 Goal、Compose、审批或 Snapshot。

邻近文件：thread_persistence.py、host 分叉处理与测试。验收：故障注入零空壳；同请求重复只创建一次；冲突明确拒绝；源删除后新会话正常。

### A3 Protocol 与交互意图（依赖 A2，中等）

在 canonical schema 注册 threads.fork 与错误映射，生成两端类型；SDK/gateway 接入。实时消息和 threads.open 都传 record_id/run_id；Interactive Core 提交 target ID 并在创建成功后打开，迟到响应遵循 epoch。

邻近职责：Protocol、AgentHost dispatch、SDK gateway、interactive/features/thread-feature.ts。该步按这些 seam 分成小提交，合约生成后逐个迁移，无临时别名。

验收：两端 schema 一致；同操作网络重试沿用 ID；创建成功但打开失败保留 ID 并只重试打开。

### A4 Web 操作闭环（依赖 A3，中等）

Web adapter/UI contract 按下一版本生成迁移，回答下增加图标、提示及可访问名称；成功最终主回答才有按钮，忙碌/交互期间禁用；列表新增并自动切换，源草稿保留，新草稿为空。

邻近职责：web/application/adapter.ts、WebUiGateway 契约、web/presentation/timeline.tsx 与测试。按意图和视图分别修改，不能让 Browser 直连 Agent。

**用户演示**：npm run dev → /web → 三轮普通对话 → 第二轮回答点“从此处分叉” → 新会话只有前两轮 → 继续追问 → 原会话仍有三轮。刷新新会话历史不变。A 以受控普通/工具配对历史验证；复杂压缩/异常场景待 B。更新 Todo、证据、tmp/handoff.md 后停止。

## 停点 B：复杂历史、重复分叉与异常恢复可用

### B1 压缩和 artifact 历史（依赖 A，中等）

验证分叉点前脱水结果/摘要独立可用，点后压缩摘要不进入新分支。补全复制引用闭包中的实际缺口，但不得扩大 Spec；不足历史明确拒绝。检查主/child 边界，child 过程输出不成为分叉按钮。

邻近文件：分叉服务、context_projection 及持久化测试。验收：模型输入无后续独有事实，工具调用配对；删除源后 artifact 仍可读。

### B2 再次分叉及操作恢复（依赖 B1，中等）

从继承历史再次分叉，检验来源映射、用量摘要和独立模型状态；覆盖双击、断线后重试、目标冲突、用户切换后的迟到结果。主流程使用请求 ID 幂等，不增加第二份前端会话数据库。

邻近文件：分叉测试、interactive thread tests、Web adapter/Timeline tests。验收：不重复建会话、不抢回选择、不把历史用量记成新调用。

### B3 用户文档、检查与 review（依赖 B2，中等）

补 mock 跨层测试并验证工作区文件、HEAD、index 未改变，Snapshot 没继承。更新 docs/user/Web界面.md 与现有会话/上下文架构及架构总览；执行 code-review-and-quality 写回 Task。

**用户演示**：打开含工具/压缩的历史，在中间回答分叉；查看保留用量及独立新回答，再从继承回答分叉一次。检查原会话和工作区均未改变。全部证据齐全、用户验收后归档。

## 验证命令

- Python：node scripts/dependencies/run_python.mjs -m pytest -q packages/agent/tests/threads/test_thread_fork.py（新增）及受影响 persistence/host tests；合约测试覆盖请求与所有错误。
- CLI：packages/cli 下 bun test tests/interactive/thread-feature.test.ts tests/web/application/adapter.test.ts tests/web/presentation/timeline.test.tsx，追加受影响 gateway/SDK tests。
- 每停点 npm run protocol:check、npm run typecheck 及 focused tests。提交前 npm run project:check、npm run typecheck、npm run test、npm run build；只记录 sandbox 限制，不为被禁宿主测试申请权限。
- Web 变更附终端启动和页面截图；OpenWiki 可用则刷新，否则记录工具缺失。
- 无主动版本变更；仅提交本任务范围，不清理已有用户改动。

## 风险与处理

不可独立复制的 artifact 或源历史不完整：返回 history-unavailable，不拿最新 checkpoint 补齐。跨会话锁死锁风险：统一锁顺序并通过竞态测试。schema 与 HC-194 顺序冲突：按前置完成后的当前版本递增，禁止固定旧版本号。出现 Spec 未覆盖的生命周期问题停止并回写，不边实现边决定。

用户确认 Plan/Todo 后一次只实施 A，等待用户查看后再推进 B。

