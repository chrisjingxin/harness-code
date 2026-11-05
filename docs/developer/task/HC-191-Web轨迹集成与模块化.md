---
id: HC-191
title: Web轨迹集成与模块化
feature_area: Web UI 工作台体验升级
parent_task: -
decomposed_by: 历史未记录
priority: P1
status: 进行中
owner: Codex
branch: trace_merge
scope: 在主仓库集成内网既有 Trace 功能并统一主题，隔离展示、数据与宿主接线，验收后一次性迁回内网。
acceptance: Trace 功能与内网基线一致；当前 Web 行为保留；双主题统一；真实历史与实时链路分别验证；提供可迁移边界与证据。
user_docs: docs/user/Web界面.md
developer_docs: docs/developer/spec/HC-191-Web轨迹集成与模块化.md、docs/developer/plan/HC-191-Web轨迹集成与模块化.md、docs/developer/todo/HC-191-Web轨迹集成与模块化.md
test_evidence: "dev 本地迁移复核：typecheck、build、额外夹具类型检查通过；相关回归 428 pass，浏览器布局 13 pass，接管恢复 2 pass。CLI 全量 1344 pass / 1 skip / 1 既有高亮断言失败；工程检查受 dev 原有本地链接影响，Python 依赖门禁未通过。"
references: docs/developer/task/HC-190-Web主题布局与Git提交.md
completed_at: -
---

# Web轨迹集成与模块化

## 已确认的用户结果

主仓库已有新版 Web 工作台，内网独立项目已有 Trace 可视化。先把两者在主仓库整合并统一走查，再一次性迁回内网，保留内网 SDK 和其他专有修改。模块化用于缩小迁移范围，不拆独立应用，不引入发布包或通用插件框架。

2026-11-02 用户确认修正版设计稿，明确要求保留设计稿；Trace **不能新增或减少功能**，只统一主题、间距和外层布局。沿用用户之前的“跳过 skill 调用”，保留正式文档、TDD 与阶段验收。没有提交、推送、新建分支或覆盖内网历史的授权。

## 基线与设计保存

- 主仓库基线：`f94b70ff458fedd839dc0892b47a085192f28dda`，包含未提交 HC-190 修改；全部保留。
- 内网只读基线：`27e4e6eb44e3226486136016df8c660ca52ee600`；两边无共同祖先，不整树覆盖或合并无关历史。
- 确认稿在同级规划工作区 `harness-code docs/plans/previews/archive/2026-11-02-trace-approved/`，包含 HTML、截图和 SHA-256 清单。HTML 哈希为 `08ced83949aab5ff4a7d1cf393d49103ed86aac18ef9fdd052e7ed241b19b9a0`。原工作台稿与当前 Trace 预览继续保留，后续修改不得覆盖归档版本。
- 设计稿使用内网原组件和合成 Span。预览通过不等于生产数据链路通过。

## 范围与验收

- [x] 内网开发者／简化模式、多轮图表、调用树、详情、原始 JSON、折叠与拖拽全部可达；默认开发者模式。
- [x] 颜色集中在现有主题文件，浅色白底冷紫、深色中性底；保留类型和状态色语义。
- [x] Trace 通过小范围数据接口消费 Span，不依赖完整 Web adapter、SDK、文件系统或网关实现。
- [x] 中央对话／轨迹切换；进入轨迹暂时隐藏文件／Git 栏，返回时保留原状态；对话头像、工具、草稿、滚动与设置行为不退化。
- [x] 历史与实时数据经统一 CLI 服务进入 Web；会话隔离、增量合并、加载结束、断连及清理均验证。
- [ ] 内网真实 SDK 运行完成端到端验收；外网同格式消费已用合成日志验证，不能冒充实际 SDK 产出。
- [x] 统一走查 HC-190 与 Trace，并给出内网迁移文件清单、基线、契约变更、验证和恢复说明。

不新增搜索、导出、刷新按钮、详情页签或审批操作；不删除简化／开发者任一信息范围。预览场景开关只在开发验证材料中。

## 当前实施边界

展示模块、工作台、历史与实时日志消费已接线，迁移清单已形成；等待用户统一查看及内网真实 SDK 验收。外网不会产生伪造的生产 Span。

内网采集依赖 `za38-02-cmb-llm-sdk==1.2.3`，主仓库没有该依赖，本地还原树未发现 wheel。按 2026-11-03 用户澄清，完成 CLI 同格式消费链但不安装私有包、不替换主仓库 Agent 引擎；真实 SDK 端到端在内网验收。

## 交付与回退

按同名 Plan 的可演示停点推进。版本保持不变；任务未完成不归档。回退只撤销本任务明确文件，不重置已有工作树，不删除设计与日志。迁移内网前重新核对其最新基线；实际 Git 交付操作另按用户指令执行。

## WP1 实施与 Review（2026-11-02）

内网展示逻辑迁入主仓库 `packages/cli/src/web/presentation/trace/`，共享 Span 类型独立于 SDK。根组件改为 `TraceViewState` 窄输入，加载请求移出表现层；展示模块无 adapter、网络和文件系统导入。功能入口与模式、树、三轨顺序图、详情和文本折叠保持，颜色统一进入既有 `theme.css`，布局独立为 `trace.css`。

本停点未修改 WebApp、adapter、UI client、gateway 或 Python；生产页没有新增 Trace 入口和伪造数据。独立验证页位于规划工作区 `plans/previews/harness-trace-module.html`，直接打包主仓库组件，合成数据仅在规划区构建源中。原确认稿和归档版本的 SHA-256 均复核未变。

TDD 与维护性修正：

- 初始测试因模块缺失 4 errors；迁入后 61 pass、4 fail，覆盖连续拖动重复累计、主题变量缺失和旧硬编码颜色断言。修正后通过。
- 新增“选中后折叠轮次，再收到增量仍保持折叠”的测试，先失败再修正；再次点击同一图表节点仍可展开定位。
- 连续拖动光标在 React 更新后提前清理的问题先失败再修正；取消、失焦与卸载成对清理监听。
- 选中详情从最新快照取值、跨会话清理选择的回归通过；没有增加信息字段或产品操作。
- 双主题全部类型标签文字对比度 ≥4.5；品牌变化与成功／失败等状态语义独立。

验证命令与边界：

1. `bun test --isolate packages/cli/tests/web/presentation/trace-module.test.tsx packages/cli/tests/web/presentation/trace-view.test.tsx packages/cli/tests/web/presentation/trace-simple-mode.test.tsx packages/cli/tests/web/presentation/trace-fold.test.tsx packages/cli/tests/web/presentation/theme.test.ts`：69 pass。
2. `bun test --isolate packages/cli/tests/web/presentation packages/cli/tests/web/application packages/cli/tests/web/architecture.test.ts`：372 pass。
3. `npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check`：通过。普通沙箱不能写主仓库构建产物，获得自动审批后完成构建。当前没有生产入口引用 Trace，Trace 自身浏览器构建由独立预览验证。
4. 浏览器 1280×800：开发者／简化、多轮、图表定位、原始详情折叠、608 字回复展开、工具 FILE_CHANGED、运行中、三个空态、浅深主题；图表高度 140→160px，详情宽度 360→380px。600×760：660px 内容区可横向滚动，滚动位置实测 60px。控制台无 error/warn；截图在规划区 `plans/previews/harness-trace-module-{light,dark}.png`。
5. 主仓库功能模块预览构建成功；内网工作树仍干净。未做真实 SDK 采集、历史服务、网关重连、生产页切换状态保持、大量节点压力和跨平台验证；未运行全量 npm test/Python，本轮未改 IPC/Python。原 HC-190 环境和历史测试失败不据此宣称解决。

Review 结论：展示模块阶段可演示；全任务验收项继续保持未勾选，WP2 需要补齐数据帧与生命周期规格后接工作台，WP3 仍有 SDK 前置条件。OpenWiki 命令未安装，未手工修改生成页面。未创建分支、提交或推送，版本不变；当前停在 Plan WP1 等用户查看。

## 2026-11-03 用户澄清

用户确认仅要求 `git add` 后继续开发，未执行新的 stash；后续要求开发完一起验证。内网 SDK 没有外网安装包，使用逻辑保持内网一致即可。按 Spec 补充章节完成日志消费与实时推送，保留内网 Python SDK 生成端；本地用合成日志验证，真实 SDK 端到端在内网验收。此项是验证环境边界，不把本地回放称为真实 SDK 采集通过。

## WP2/WP3 实施与统一验证（2026-11-03）

用户要求开发完统一验证，已接通中央页签、历史日志服务、单连接请求管理、实时缓存、按会话 TraceStore 与 sidecar stderr 消费。沿用内网 marker、默认日期目录、环境开关和 thread 索引格式；内网 Python SDK 生成端保持原样。直接消费已持有的 stderr 字节流，替代重复 tail 当前日志，避免两套解析路径；内网展示功能未增减。

本轮范围为 CLI TypeScript、对应测试与文档；没有修改 Python、JSON-RPC 或依赖版本，没有在生产模块注入演示数据。界面保留原头像与工具，切换 Trace 只隐藏聊天和 Dock；补了隐藏期间新消息不改变原滚动位置的回归。Git 快速提交／推送和设置沿用 HC-190，实现检查和本轮相关测试共同覆盖。

TDD 证据：parser/history、传输/store、Runtime、实时合并最初因模块或方法缺失失败；工作台入口和 DOM 保留最初 2 fail；隐藏聊天滚动测试最初 1 fail，随后修复。新增 WebUiClient 和真实 Gateway 连接快照／归还时取消测试。统一测试发现旧 Adapter parity 替身没有新接口、架构正则误匹配 Trace 注释；分别更新替身与注释后纳入最终通过集合。

验证结果：

- `/tmp/hc191-final-related.log` 对应 Trace、Web、Git、Adapter parity、验收架构及 Gateway 的 37 文件集合：**471 pass / 0 fail**。含此前 focused，不能相加当不同测试数量。
- `npm run typecheck`、`npm run build`、`npm run project:check` 与暂存／工作区 diff whitespace 检查通过；OpenWiki 和 CodeGraph 命令不可用，未手改生成文件。
- `npm run test` 中工程脚本 17 pass、依赖脚本 17 pass；CLI 首次全量 1254 pass / 1 skip / 9 fail。两项本轮问题已在上述最终集合修复验证，未伪称再次全量全绿。其余为既有根 dev／运行上下文断言 2 项、沙箱 loopback 监听 4 项，以及 sidecar 诊断目录不可写导致 stderr 出现 `HARNESS_DIAGNOSTIC_WRITER_FAILED` 1 项。按仓库规范未在沙箱外补跑宿主测试；takeover recovery 在 `&&` 后未运行。
- `npm run test:py` 单独执行被既有 deps:check 拦截：OpenTUI／bun-ffi 链接缺失、react-devtools 路径不符、darwin-x64 native 包缺失，pytest 未启动。没有修改或重装依赖。
- 真实 Web 页面经实际文件服务、Gateway、WebSocket 和 adapter 验证：历史 2 轮 10 事件；运行时注入合成 SDK marker 后变为 3 轮 11 事件，完成信息可见；两种模式、失败详情、raw JSON、浅深主题、设置弹窗与返回对话草稿／工具展开／Dock 保留；切换第二会话显示独立空态。数据只在规划区调试脚本的临时目录，未调用模型或实际 Git 写操作。
- 桌面 1440×900 截图保存在规划区 `plans/previews/harness-trace-integrated-light.png` 与 `harness-trace-integrated-dark.png`。确认稿与归档 HTML 哈希仍为 `08ced83949aab5ff4a7d1cf393d49103ed86aac18ef9fdd052e7ed241b19b9a0`，内网工作树仍干净。

Review：已检查连接替换不串结果、请求关闭收敛、路径边界、当前／历史合并、重复 start/end、thread 回填／冲突、observer 错误隔离、组件保留及两边源代码边界。仍未做内网实际 SDK、跨平台／大量日志长时压力、实际网络 Git 认证和完整模型审批走查。任务保持进行中，待用户统一查看及内网最终验收；不归档、不升级版本。

Git 状态：按用户指令已 `git add` 前一批 84 文件；其后本轮开发留在工作区，未重复暂存，未 stash、commit、push。原先 HC-190 stash 保留不动。迁移说明位于 Plan 末尾与 `architecture/Web轨迹.md`，内网尚未写入。

## 当前仓库验证收尾（2026-11-03）

用户要求先在主仓库收敛验证缺口；随后明确包差异造成的测试失败可以记录，Trace 的功能、采集字段和使用逻辑仍以内网基线为准。本轮没有修改内网副本、私有 SDK、Python 引擎、依赖声明或锁文件。

新增跨文件失败测试发现：分别解析每个文件再按节点覆盖，会丢失另一文件中的 start 或 end。已将纯解析缓冲独立为 `TraceLogParser`，全部候选文件共用同一个缓冲，仍保留内网“start 父节点优先、metadata 浅合并、首次 end 优先”的规则。测试先以完成状态与输入缺失失败，修复后正序／倒序文件均通过；Runtime 仍消费原 marker，关闭补充清空会话索引缓存。两个非 Trace 的旧断言按当前 README/npm 入口与根 VERSION 修正，只改测试，不修改产品启动方式或版本。

验证范围与结果：

- 历史服务验证恰好 64 MiB／累计 128 MiB 可以读取、超过上限整体失败，8 MiB 索引、256 文件和 100000 Span 的上限；恰好 100000 节点完整返回。网关补充超大 raw 整体拒绝与四请求并发／关闭中止；Runtime 验证完整和未闭合超大 marker 只诊断一次，关闭后不再写入。临时文件全部清理，不访问真实运行日志。
- 展示验证 200 轮／1000 节点，开发者／简化切换后轮次与图表分界完整，最后一轮可定位，回到开发者模式无节点丢失。没有新增产品入口或删改简化规则。
- `HARNESS_TRACE_SOAK_MS=180000 bun test tests/trace-log/soak.test.ts`（CLI 目录）：**1 pass**，实际 180346 ms、2185 轮／6555 Span／17480 次实时更新。包含中文跨字节块、会话回填、重复／迟到帧、失败轮次、三会话隔离、网关历史分帧、关闭后重新打开日志，最终历史和实时一致。JavaScript 堆抽样起始 1 MiB、峰值 56 MiB，仅作当前规模观察，不代表 RSS 或无限时长保证；日志 `/tmp/hc191-gap-soak.log`。
- 规划区只读对照脚本 `tmp/hc191-trace-parity.ts` 对内网 `27e4e6e` 的真实纯函数执行合成输入：8 种 thread 字段载体 × 正序／乱序共 **16 场景**，每场景 14 Span；解析字段、建树、简化树、图表轨道、节点名、状态和工具失败识别相同。未读真实业务日志，内网工作树仍干净；日志 `/tmp/hc191-gap-parity.log`。
- 最终在宿主补跑 `npm test`：工程脚本 **17 pass**、依赖脚本 **17 pass**、CLI 主集合 **1275 pass / 1 skip / 0 fail**（144 文件），随后浏览器接管恢复 **2 pass / 0 fail**。原跳过项是需显式开启的 OpenAI-compatible gateway 集成，不属于 Trace SDK 产出。此前 4 项 loopback 和 1 项诊断目录权限失败均已通过；丢帧看门狗恢复、凭据过期后刷新重连通过。日志 `/tmp/hc191-gap-final-all.log`；单独宿主 7 项验证也通过（`/tmp/hc191-gap-host-tests.log`），与最终全量重复，不重复累计。
- `npm run typecheck`、`npm run build`、`npm run project:check`、暂存／工作区 whitespace 检查通过。原设计与确认归档 SHA-256 不变。
- 本地 npm 安装曾混用旧 Bun 解析路径，按既有锁文件完成 npm 冻结安装后，五个源码化包与当前平台 native 门禁通过。Python 冻结同步被锁文件项目版本 0.1.0 与 manifest 0.2.0 的既有差异拦截；既有虚拟环境仍是 DeepAgents 0.6.8（声明为 0.7.3）、缺补丁且存在项目门禁禁止的分发。最终 `npm test` 在 Python `deps:check` 处退出 1，pytest 未启动。按用户澄清记录环境差异，不为外网全绿切换内网包或改锁文件；不能把整个 npm test 描述为通过。

Review：当前仓库可执行的 Trace 边界、压力、持续消费和连接恢复验证已收敛；SDK 输入字段和展示算法继续对齐内网，未修改 RPC／引擎或扩大功能。当前规模的验证通过不替代内网真实 SDK、目标系统及长周期生产运行验收。最终用户视觉验收和实际内网整合／Git 交付仍未执行，Task 保持进行中。新增修改仍未暂存，原 84 文件暂存检查点保留，未新增 stash、提交或推送。

## 主仓库交付分支（2026-11-03）

用户明确要求将主仓库本次 HC-190／HC-191 改动提交，并推送到指定的新分支 `trace_merge`。本次按用户指定名称交付，主仓库 `master` 保持原提交；内网副本的独立提交与 ZIP 导入包保持原样。已认领任务不能重复执行 `task:claim`，因此仅将上述任务的 branch 字段同步到实际交付分支，保留 owner 和进行中状态，并使用 `tasks:sync` 更新看板。

提交前重新执行 `npm run typecheck`、`npm run project:check` 均通过；`npm test` 中工程测试与依赖脚本各 17 pass，CLI 主集合 1275 pass / 1 skip / 0 fail，浏览器接管恢复另 2 pass / 0 fail。Python 阶段仍因本机 DeepAgents 0.6.8 与声明 0.7.3 不一致、缺少项目补丁及禁止分发门禁退出，pytest 未启动；整个 `npm test` 退出 1。沿用用户已确认的环境差异边界，不修改 Python、私有 SDK、依赖声明或锁文件。验证日志保存在本地忽略目录 `tmp/trace-merge-20261103/`。

本次只做主仓库提交交付，不新增功能或改动版本；内网真实 SDK、目标环境与最终用户验收仍待完成，任务不归档。OpenWiki 命令未安装，未手改生成页面。设计稿及归档继续保留。


## 分辨率与样式复核（2026-11-04）

用户要求先在主仓库修正并走查，检查通过后另行迁移内网；本轮不提交、不推送。保留三轨、调用树、详情和两处分隔条拖拽；甘特图可视高度最多占当前 Trace 区域 45%，三轨最少保留 72px；详情列最多占当前内容宽度一半。窗口缩小后调用树和详情仍可见，窄窗口横向滚动。拖动请求范围保留，显示尺寸受可用空间约束，不改变 Trace 数据和功能。

本轮验证：

- `npx playwright test -c packages/cli/tests/e2e layout.spec.ts --output=tmp/layout-test-results --reporter=line`：11 pass。真实 WebApp 组件 + 合成快照，覆盖 1920×1080、1440×900、1366×768、1280×600、1024×480，另检查 1280×360 深色与 800/600px 窄窗 Trace。先复现关闭图标偏移 3px、Trace 缩窗下半区高度为 0、右栏拖宽后内容宽度计算错误与窄窗 Trace 错占 280px 列，再修正并通过。
- Web presentation/application/architecture focused：376 pass；测试夹具补齐当前类型后 presentation 复跑 284 pass，额外夹具 TypeScript 检查通过。
- `npm run test:ts`：1275 pass / 1 skip / 0 fail；接管恢复另 2 pass。
- `npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check`：通过。
- 对照保留原稿检查品牌 Command 图标、280px 左栏、无边框会话选中、消息头像、右栏主/文件页签。原稿和内网仓库未修改；没有提交或推送。生产改动仅 4 个 Web 展示文件，未修改 SDK、Agent、协议与 Trace 数据算法。
- 本机浏览器验证不代表内网 Windows/浏览器缩放已验收；Python/私有 SDK 不属于本轮样式改动，未重跑。`openwiki code --update --print` 因本机缺少命令退出 127，生成 Wiki 未手改。

截图和日志保存在主仓库忽略目录 `tmp/layout-*`。独立布局预览可在主仓库运行 `bun packages/cli/tests/e2e/layout-server.ts`，使用它打印的本机 URL；仅使用演示数据，不执行真实 Git 或模型请求。真实工作台重新启动 `npm run dev` 并输入 `/web` 查看已构建资源。用户检查通过后再迁移内网。


## 主仓库提交复核（2026-11-05）

用户明确授权把当前主仓库改动提交并推送到远端 `trace_merge`。本次包含分辨率布局修复、中央可关闭文件页签、紧凑文件操作图标、顶部项目名及文字/图标对齐、底部重复状态行移除。Review 确认改动集中于 CLI Web、相关回归和文档；没有修改 Protocol、Python、私有 SDK、依赖锁或版本，没有迁移本轮改动到内网仓库。设计稿保持保留，最终内网真实 SDK 与目标环境验收仍待完成，任务不归档。

提交前完整测试发现文件操作悬停背景引用未定义的 `--surface-hover`，已改用现有双主题变量 `--surface-2`；主题契约 4 pass，随后完整 CLI 测试无失败。

- `npm run project:check`、`npm run typecheck`、`npm run build` 与 diff 空白检查通过。
- `npm test`：工程与依赖脚本各 17 pass；CLI 主集合 1288 pass / 1 skip / 0 fail；独立接管恢复 2 pass / 0 fail。唯一跳过项为原有真实模型端到端用例。
- `npm test` 最终退出 1：Python 依赖门禁仍检测到 DeepAgents 安装 0.6.8 与声明 0.7.3 不符、缺少项目补丁，以及环境中保留 Anthropic 分发包/引用；pytest 未启动。与前次交付记录一致，按用户确认保留内网依赖逻辑，不为通过外网检查改包或锁文件。
- Playwright 布局回归 13 pass，覆盖文件标签开关、独立关闭与去重、草稿/滚动/焦点保留、浅深主题、多分辨率、缩窗后 Git/Trace 可达性。使用真实组件与合成数据，不替代内网实测。
- 本轮日志与浏览器输出保存在主仓库忽略目录 `tmp/trace-merge-commit-*`。`openwiki code --update --print` 因命令缺失退出 127，未手改生成 Wiki。


## dev 本地迁移（2026-11-05）

用户要求以最新远端 `origin/dev` 为基础，在主仓库本地迁入 `origin/trace_merge` 领先 `origin/master` 的两条提交，并明确禁止推送。迁移基线为 `3825f67df0615b9c2d49e6ad6ba203e3a60e7de4`，来源依次为 `7a8cd04413203c9e7be96f2aa29fa445d81fb48a` 与 `91245bd4ec86ab38581817b5c838bb209d3ca811`，保留两个独立提交并记录来源。

第一条提交产生 7 处冲突：保留 dev 的启动入口注释和运行时绑定、代码索引状态/浮层、与 InteractiveIntent 编译期绑定的完整意图白名单及 Goal/模式校验，再接入 Git 意图与 Trace 历史/实时读取；测试入口保留双方新增集合。任务看板通过 `tasks:sync` 重建，保留 dev 任务。第二条提交自动合并。另为 dev 新增的代码索引测试补齐 Trace 客户端方法，在共享 Web 夹具中补齐 `codeIndex: null`，避免迁移后遗漏状态或测试接口。

Review 确认 Agent、Protocol、依赖锁、安装脚本与 dev 运行时绑定保持原样；原 master/trace_merge 分支保留，远端未写入。迁移相关回归 428 pass，浏览器布局 13 pass，生产 TypeScript、额外 E2E/夹具类型检查与构建通过。

项目检查在 dev 原有的 `docs/developer/research/182-模型路由委派评估.md` 失效本地链接处退出；已确认该文件相对 origin/dev 未变化。首次全量测试的 wheel 构建发生 5 秒超时，单独以 30 秒上限复跑 6 pass；同时发现的代码索引假客户端缺少 Trace 方法已修正。未为通过检查修改 dev 原有研究文档、Python 或内网依赖。OpenWiki 命令仍未安装，未手改生成 Wiki。

最终验证：复跑 `npm test` 的工程与依赖脚本通过，CLI 1344 pass / 1 skip / 1 fail，唯一失败为 `tests/web/syntax/worker.test.ts` 对 `const` 高亮范围的断言。单独运行仍失败，worker 与测试均和 origin/dev 字节一致，本轮未修改；因此不把全量检查报告为通过。接管恢复另行执行 2 pass。`npm run test:py` 在原有 DeepAgents/Anthropic 依赖门禁退出，pytest 未启动。验证命令、回归输出和限制保存在主仓库忽略目录 `tmp/dev-trace-migration-*`，不包含真实模型请求。为保持两条迁移提交，将测试夹具适配和本段记录纳入第二条本地提交；不推送远端。
