# Web 轨迹架构

功能规格见 [HC-191](../spec/HC-191-Web轨迹集成与模块化.md)。目标是在保留内网 Trace 功能的同时，把展示、浏览器状态、传输和日志来源分开，迁移时不覆盖内网 Agent 引擎。

## 数据流

SDK stderr marker → `TraceRuntime` 增量解码与合并 → 串行写日志／索引 → 实时订阅 → WebUiGateway → WebUiClient → TraceStore → TraceView。

历史入口：进入轨迹／切换会话 → `trace.load` → `TraceHistorySession` → `loadThread` → 索引定位与路径检查 → 分条 `trace.span` + `trace.loaded` → 与实时缓存合并。

- `trace-log/parser.ts`：复用内网 marker、start/end、metadata、thread 解释；纯解析，无 SDK 导入。单文件使用 `parseTraceText`，历史多文件共享 `TraceLogParser` 缓冲，防止不同文件中的 start/end 相互覆盖。
- `trace-log/history.ts`：只读文件服务，二次按 Span 归属过滤，拒绝路径越界／符号链接越界。索引与默认日期布局兼容内网；显式配置的单个外部日志是单独允许项。
- `trace-log/runtime.ts`：接收 sidecar stderr 字节，跨 chunk 解码；原始记录、thread/file 索引串行写入，已完成 span 不被迟到 start 降级。只在有效日志出现时创建文件；独立端口提供 `snapshot/subscribe/loadThread/close`。直接消费当前进程已经持有的 stderr，不再额外 tail 自己刚写入的文件。
- `presentation-coordinator/contracts/trace.ts`：Span 与历史／实时帧类型。UI 版本 10；独立于 Agent RPC。
- `presentation-coordinator/trace-history-session.ts`：请求 ID、并发上限、终态、原连接绑定和中止；旧连接结果不能写给新连接。
- `web/infrastructure/trace-*-client.ts`：历史请求聚合与超时、实时修订缓存；断连清理。
- `web/application/trace-store.ts`：按会话保存历史和实时投影；实时同键结果优先于历史，未知归属／冲突回填不显示到错误会话。
- `web/presentation/trace/`：内网原展示算法；状态输入不含 adapter 或 SDK。颜色在 `theme.css`，布局在模块 CSS。
- `workbench-views.tsx/css`：中央页签与开发者／简化切换。聊天和 Dock 常驻，隐藏区域 inert；Timeline 隐藏时停止自动滚动。设置状态独立。

布局尺寸属于展示模块：拖动保存请求尺寸，CSS 约束实际可视尺寸。甘特区至少 120px 以容纳 72px 三轨和标题，常规窗口最多占 Trace 可用高度 45%；详情列不超过双列区宽度的一半。视口缩小时自动收敛，放大后恢复请求尺寸；窄窗口通过宿主横向滚动访问最小双列宽度，不改 Span 数据或折叠状态。

## 生命周期与保护边界

CLI `startAgent` 在 stderr 监听处将字节同时送入既有 drain 和 TraceRuntime。正常退出与初始化失败都关闭 Runtime；不改变 stdout JSON-RPC。Gateway 订阅 Runtime，连接时回放当前进程缓存；关闭解绑。浏览器断开时关闭实时订阅并结算历史请求，Adapter 释放本地订阅。没有 SDK 日志时不生成 Span。

历史请求有 30 秒浏览器超时，服务读取可中止，每连接最多 4 个并发请求。历史单文件 64 MiB、总计 128 MiB、256 文件与 100000 Span，超限整体失败，不截掉 raw 后宣称成功。单帧遵循 8 MiB Web 上限。Runtime 的单记录、待写队列和缓存也有资源限制；失败用固定诊断字段报告，不记录日志内容或文件路径，不阻断模型 RPC。主仓库已验证三分钟／6555 Span 持续消费和 200 轮／1000 节点双模式展示，见 HC-191 证据；真实 SDK、目标系统和长周期生产运行仍需在内网验收。

## 内网迁移

按 [HC-191 实施计划](../plan/HC-191-Web轨迹集成与模块化.md) 的迁移清单执行。内网 SDK 启用、装饰器、Run/Thread 生命周期挂载以及 `pyproject.toml` 保留，不复制主仓库 Python 去覆盖。旧 CLI 的 trace-tailer/index 接线应被本 Runtime 消费入口替换，不能让同一个 stderr 写入两份日志或重复推送。若内网选择继续使用已有 Tailer，应适配同一 `TraceLiveSource`/`TraceHistorySource` 端口并移除重复消费入口；一次迁移只能保留一条生产路径，不长期双写。

## HC-192：v2 读取与载荷展示

Agent 将 schema v2 JSONL 写到用户目录的工作区指纹子目录。CLI 用 `realpath(workspace)` 的 UTF-8 SHA-256 定位相同目录，历史和实时刷新共享该读取器。根目录的内网 marker 索引保持原读取规则，v1 JSONL 被跳过。

读取一轮的全部轮转文件后，单个 TraceLogParser 合并 span 开始/结束和按 trace_id 隔离的 payload 表，避免跨文件引用缺失。64MiB 单文件、128MiB 总量、256 文件和 10 万 span 上限继续失败关闭；取消、路径穿越和符号链接的检查保持在文件边界。

Browser 保留实际 Step 父子关系，同一 Step 的多条 db.persist 展示为可展开的事务组；六区详情按 payload_id 展开正文，缺失引用显示固定提示。v2 耗时只读 duration_ms。窗口按 session_id 隔离 Thread，引用不跨 trace 解析。

受理阶段延续同一个 run.prepare span，准备函数成功返回后交给 RunCoordinator 在受理成功、重复或失败时关闭；执行阶段显式绑定 Run 的 TraceContext。子代理分支按父 tool.call 隔离 Step，避免关闭父代理当前轮次。
