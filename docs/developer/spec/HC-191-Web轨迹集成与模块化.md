# HC-191：Web轨迹集成与模块化规格

来源：[Task](../task/HC-191-Web轨迹集成与模块化.md)。用户已确认功能边界与设计稿；本规格把确认内容落实到模块接口。

## 用户流程与视觉

当前会话 → 中央“轨迹”页签 → 查看全部轮次概览与调用树 → 点击节点查看详情。默认开发者模式，可切换简化模式；回到“对话”后草稿、工具展开、滚动位置、文件页签、Git 勾选与提交说明保持。设置继续为独立居中弹窗。

左侧 280px 默认宽度与拖动不变。Trace 展开时文件／Git 栏仅隐藏，不能卸载或重置。图表保留 Input／Model／Tools 三轨等宽顺序节点、多轮分界、悬停提示；点击节点展开其祖先和轮次并定位。图表高度初始 140px、范围 84–600px；详情宽度初始 360px、范围 300–600px；拖动保留 0.5 灵敏度，按连续位移计算，不能重复累计起点差。窄窗口横向滚动，不能隐藏既有字段。

类型、状态、模式与审批标签保留。背景、分隔线、文字、选中、悬停和类型色统一引用 `web/presentation/theme.css`。Trace 样式独立放入模块，不能继续向主 `styles.css` 堆放功能样式。

## 功能对齐矩阵

| 内网功能 | 主仓库必须保持 |
| --- | --- |
| 开发者调用树 | 全部节点、层级、按 trace 分组、用户原话、耗时、节点数、分组及子节点折叠 |
| 简化调用树 | 原简化规则：过滤噪声节点、展开模型包装、聚合 tools；不能自行删改节点类别 |
| 开发者详情 | span/parent/trace ID、raw JSON、起止时间、耗时、metadata、JSON 高亮与超过 200 字字符串折叠 |
| 简化详情 | 自然语言摘要、回复引语、模型、Token、首字时间、模式、审批、工具、状态和结果；超过 500 字折叠 |
| 工具失败 | 保留 payload 失败识别，即 span 为 SUCCESS 也显示载荷失败结果 |
| 运行与空态 | 进行中节点、未开启追踪、历史加载中、该线程暂无数据 |
| 交互 | 图表定位、树折叠、模式切换、两处分隔条拖拽；不加额外详情页签或刷新按钮 |

## 模块边界与首阶段接口

`presentation-coordinator/contracts/trace.ts` 定义可序列化 `TraceSpanEvent`，保留内网已有字段和可选性：traceId、spanId、parentSpanId、name、type、startTime、endTime、durationMs、status、metadata、threadId、raw。类型本身不承诺已脱敏；敏感内容应由采集和服务端出口处理，保留关联 ID。

`web/presentation/trace/index.ts` 是展示模块公开入口，导出 `TraceView` 与 `TraceViewState`。根组件接收：

```ts
type TraceViewState = {
  threadId: string | null
  spans: readonly TraceSpanEvent[] // 已按当前会话选取
  loading: boolean
  loaded: boolean
  hasAnyTrace: boolean
}
// props：state、disabled?、mode?；mode 默认 dev，另一个值为 simple。
```

根组件只渲染，不请求历史、不接收完整 WebAdapterSnapshot 或 WebIntent。加载触发归应用层：进入轨迹或切换会话时发起一次，加载完成不能自动触发下一次；重入视图可补拉。根组件用 traceId+spanId 保存选中键；增量数据到达时显示同键最新详情，不抢选中，不跨会话保留详情。控件状态留在模块内，返回对话时保持实例；切换会话时以 threadId 隔离节点选择和折叠。

内网纯展示算法与现有内容解释直接迁入，不重写业务。修复加载循环、选中过期数据与拖拽累计等集成缺陷属于维护原交互意图，需有行为测试，不增加产品功能。

## 后续数据与宿主边界

CLI 独立 Trace 服务负责 `[[za38-log]]` 记录解析、start/end 合并、会话索引、历史回读与实时订阅；浏览器不读取文件、不知道 SDK 或日志路径。Web 应用层保存按会话归集的数据、加载状态与选择视图，客户端和网关只是传输。沿用内网索引与 Span 数据格式，按契约合并主仓库 Git 帧与内网 Trace 帧，统一升级 Web 版本，不改 Agent JSON-RPC v3 来运送界面状态。

进入视图 → 请求当前会话历史 → 服务定位日志并解析 → 同键合并历史／实时结果 → 标记加载完成。非法输入、文件不存在、读取失败、连接关闭必须收敛；失败不得永远加载，不把另一会话数据作为当前历史。WP2 的具体约束见下节。

实时来源阶段存在 SDK 前置依赖，尚未确认主仓库可用的安装包与上下文接口。当前不授权切换 Agent 引擎。后续按 2026-11-03 用户澄清完成 CLI 同格式实时消费；不以合成日志替代真实 SDK 验收。

## 验证边界

首阶段用合成数据验证真实展示组件，包括多轮、多层、进行中、失败、长文本、模式、空态、选中更新、拖拽与双主题。样例只进入测试和独立预览，不进入产品 bundle。后续阶段分别补历史、实时、断连、接管、会话隔离及原 Web 功能回归。未验证的项目保持未完成，不声称整合完成。

## WP2 历史链路规格

- CLI 的 `trace-log/history.ts` 只读内网既有 `~/.harness/trace/za38-trace-index.ndjson` 与日志；独立 `parser.ts` 保留 marker、start/end 合并、metadata 合并及 thread 归属规则。无索引或文件已删除返回空结果；其他读取失败统一返回错误，不能泄露磁盘路径。索引中目录穿越、绝对路径越界与符号链接越界均拒绝；允许根目录中的日志和日期子目录，以及宿主显式配置的单个日志路径。
- `TraceHistorySource.loadThread(threadId)` 是网关唯一数据端口。按索引找候选文件，按实际 span 的 threadId 再次过滤；只给同一 trace 唯一归属的未绑定节点回填会话，冲突归属不猜测。无索引的任意日志不扫描。单文件 64 MiB、一次总量 128 MiB、100000 个 span、256 个日志文件为保护上限；超限返回错误，不静默截掉结果。
- Web 契约版本升至 10（合并主仓库 v8 Git 与内网 v9 Trace）。Browser 发 `trace.load {requestId,threadId}`；Gateway 分条发 `trace.span {requestId,threadId,span}`，最后 `trace.loaded {requestId,threadId,spanCount,hasAnyTrace,error}`。`error` 是 null 或固定中文错误说明，失败不发布部分历史。每条帧继续受既有大小上限限制，超大单个 span 使整次请求失败，不裁掉 raw。
- 客户端独立 `TraceHistoryClient` 聚合 requestId 对应的结果，严格匹配 threadId 和数量；30 秒超时、断连、归还控制权统一结算失败并释放定时器。重新连接创建新的 client，不接受旧连接异步回读。网关读取不阻塞控制权操作，单连接至多 4 个并发请求，同一 requestId 不重复执行；关闭／离开 Web 会中止请求。
- 应用层独立 `TraceStore` 保存每会话结果；仅进入轨迹、轨迹中切换会话、重入轨迹时加载，普通状态发布不触发回读。历史完成后不循环加载。失败保留已有结果、结束 loading，通过现有通知条提示；离开后收到的其他会话结果不得覆盖当前视图。首次尚无 threadId 不请求。
- 中央页签与 Trace 内容独立组件，聊天子树和右侧 Dock 保持挂载；隐藏子树不可聚焦。打开文件／Git 时回到对话，右栏原开关、页签和草稿保持。Trace 模式仍可打开全局设置。展示模块不依赖文件系统、SDK 或 WebSocket。
- WP2 不启动 tailer，不向产品注入示例，不新增实时采集或替换 Agent；内网索引／日志可直接回读。实时来源仍在 WP3 依赖门禁内。

## WP3 日志来源接线（2026-11-03 用户澄清）

用户确认 SDK 仅在内网可用，本地没有安装包；要求使用逻辑与内网保持一致。实现 CLI 侧完整消费链，不引入外网替代 tracer、不修改主仓库 Agent 引擎，内网既有 SDK 启用、Python 装饰器与挂载继续保留。外网用合成 SDK 日志验证，实际 SDK 运行留作内网验收，不能声称外网已验证真实采集。

- `TraceRuntime` 接收 sidecar stderr 中 `[[za38-log]]` 成对记录，保留原始 JSON。按内网同名环境变量 `HARNESS_ZA38_TRACE_LOG` 选择日志文件，`off` 关闭当前采集；默认 `~/.harness/trace/YYYY-MM-DD/za38-trace-YYYYMMDD-HHmmss.log`。只有收到有效记录才创建文件，权限为用户可读写；日志与 thread/file 索引写入串行，关闭等待写入完成。
- 该进程已经持有 stderr，因此直接增量消费同一字节流，避免重复读取刚写出的文件。历史与实时共用纯解析／合并算法；SDK 的生成逻辑不变。支持 UTF-8 和 marker 跨 chunk、同一行多条、start/end 乱序、父 span 先于 thread 绑定到达；结束节点不被迟到 start 降为进行中。日志仍可供内网旧工具按原 marker 和索引回读。
- 源端口增加 `snapshot()` / `subscribe(listener)`，Web 连接时回放当前进程已绑定事件，后续增量通过 `trace.live {revision,span}` 发送。实时修订号与工作台 revision 独立；每个连接从 1 开始，浏览器拒绝旧修订。重复 start/end 按 traceId/spanId 替换，不新增树节点。未知会话先缓存，出现唯一绑定后回填；冲突归属的未绑定节点不发布。
- 浏览器独立实时缓存提供订阅给 TraceStore，当前会话仍按 threadId 选择；历史回读完成时合并实时缓存，实时结果优先，避免较旧历史把完成状态覆盖成进行中。离开轨迹仍接收当前进程事件，回到轨迹可看最新结果。
- 单条记录 8 MiB、缓存 100000 span／128 MiB；超过保护上限或落盘失败时停止该采集器、关闭资源并记录固定诊断，不阻断模型 RPC。不得输出原始日志或绝对路径到诊断。Gateway close 解除源订阅，Agent stop 在正常／异常路径关闭采集器；浏览器关闭清理实时订阅和未决历史请求。
- 历史文件服务只读，与采集器写入通过同一进程的异步队列衔接。trace.load 等待此前记录落盘再回读；不存在 SDK 产出时正常显示空态，不制造运行事件。


## 分辨率与样式复核（2026-11-04）

保留三轨、调用树、详情和两处分隔条拖拽；甘特图可视高度最多占当前 Trace 区域 45%，三轨最少保留 72px；详情列最多占当前内容宽度一半。窗口缩小后调用树和详情仍可见，窄窗口横向滚动。拖动请求范围保留，显示尺寸受可用空间约束，不改变 Trace 数据和功能。
