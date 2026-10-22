# Web 工作台

`/web` 让本机浏览器接管当前 Thread 的表现层输入权。它与 TUI 共享同一 Core、Timeline、Run、审批与 Composer 语义，只在输入方式和布局上存在差异。本页自包含 Web 端全部用户操作说明；日志查询见[诊断页](diagnostics.md)，按症状恢复见[故障排查 §17](troubleshooting.md#17-web-工作台无法打开或立即断开)。

## 接管、重连与归还

在当前 Thread **空闲**时输入 `/web`（TUI Slash Command）：

```text
/web
```

- CLI 在 `http://127.0.0.1:<随机端口>` 启动本机服务并打开系统浏览器。Host 控制权始终属于 CLI 进程；Web 只转移表现层输入权。
- **Token 保护**：URL fragment 携带一次性 bootstrap UI token（有效期为生成后 60 秒，从浏览器发起 WebSocket 升级前校验）；首次连接成功后立即轮换为 handoff 范围的单次重连 token，且每次成功连接都会再次轮换——旧 token 无法建立第二个 renderer。URL/token 不含任何 Agent 凭据，但也因此**不应复制到日志、截图、Issue 或聊天中**；若开启访问日志或代理，token 会以明文出现在其中，需自行避免。
- **刷新重连**：页面刷新后在重连宽限窗口（默认 10 秒）内用当前重连 token 自动恢复并重新同步完整视图，无需重新 `/web`。
- **归还**：点击顶栏「返回 TUI」主动归还，或直接关闭页面结束本次 Web 会话；TUI 恢复后仍是同一条 Thread、同一条 Timeline。浏览器断开后 CLI 只在宽限窗口内等待重连，超时即安全结束接管并归还 TUI。
- **首次接管失败**：CLI 在 65 秒内未完成页面就绪也会自动归还 TUI。重试前确认：浏览器能访问 `127.0.0.1` 回环地址、系统允许打开 GUI、CLI 与 Web 静态资源同版（`npm run dev` 一起构建）、企业代理/浏览器扩展/CSP 未拦截 WebSocket。
- **运行中限制**：存在活动 Run 或待处理审批/问答/目录信任时，「返回 TUI」与 Thread 切换显示禁用原因并保持只读；**取消按钮不受限**。「退出 Harness」仍可请求，走与 `/quit` 相同通道。页面处于等待 CLI 确认控制权时保持只读并显示提示横幅。
- 页面只监听回环地址，强制 CSP（`default-src 'none'` 等），只公开固定的 app、Syntax Worker、Tree-sitter WASM 路径；不要把端口改为对外监听。

## 主题与状态

- 页面初始为浅色主题；顶栏「返回 TUI」旁是**单图标主题切换按钮**（浅色显示月亮、深色显示太阳，图标表达点击后切换到的主题），aria-label/title 同步为下一动作。主题选择只在本次 Web 接管内生效，不写配置文件、不跟随系统主题、不影响 TUI。
- 视觉使用暖中性画布 + 绿色强调 token；绿色只表达当前选中、运行中、焦点和链接等交互强调。运行中与已完成同属绿色系，运行中额外叠加动画或文字（如「正在运行 · 点停止取消」），不只靠颜色。
- 顶栏状态是最高状态层级：品牌 + 版本 + 「在线」标识在左，「返回 TUI」、主题切换、更多操作（…）在右。更多菜单只含「帮助」与「退出 Harness」。模型与审批模式不在顶栏，作为 Composer 底部操作条下拉贴近输入动作。
- Timeline 底部状态条来源于当前 Run，不由 CSS 推测：运行中显示「准备运行 / 等待模型响应」（真实已观测阶段）+ 已运行时长 + 「点停止取消」；运行/等待/失败/取消各有文字与图标语义。开启系统「减弱动态效果」时 spinner 停止旋转，但状态文字、时长与取消按钮仍可用。
- Work Item（Compose 需求）以只读卡片显示标题、slug、状态（进行中 / 等待你的决定 / 需要你处理 / 已完成 / 已放弃）与当前活动。
- Git 状态标签与 TUI 共用同一来源：分支名、`detached@<短SHA>`、`非 Git 工作区` 或 `Git 状态不可用`（Status 面板的「分支」行显示同一文案）。

## 工作区外围与布局

桌面端为三栏贴边布局，全部宽度是**运行时可拖拽/自适应**的，不依赖固定像素假设：

- **左侧工作区侧栏**（Thread + Files 上下分区）：默认 296px，可拖动 220–480px，上限随窗口宽度动态收敛以保证内容列不低于 480px。Thread 与 Files 之间有垂直分隔条：未拖动时 Thread 分区高度随内容自适应（短列表不截断），拖动后按 0.2–0.8 范围内记录的比例固定。「新建 Thread」是分区标题内的次级图标按钮。文件分区标题显示文件夹图标 + 工作区名，悬停可见完整路径。
- **右侧 Context Dock**：默认 354px，可拖动 330–760px。一层 tab 切换：代码、模型、技能、MCP、Agent、状态、帮助；其中代码/状态/帮助恒可见，其余 tab 按协商 capability 显隐（如未协商 `models.read` 不显示模型 tab）。帮助也可从顶栏更多菜单打开。开关/拖拽面板不改变 Thread 或 Agent 状态。
- **中间内容列**固定居中、宽度封顶 880px；实际宽度 = 视口 − 侧栏 − 预留 Dock 宽 − 两侧各 16px 间距。预留宽度语义：Dock 打开按其实际宽度、关闭按默认宽度（354px）——拖宽 Dock 后关闭，内容列恢复默认宽度；重新打开仍保持拖宽后的宽度。开关/拖拽时内容列随轨道整体平移过渡（系统减弱动态效果时瞬时切换）。
- **侧栏内部**：Thread 项主标签是短标题（`/title` 或第一条消息后自动起名），无标题时显示截断后的第一条原文；搜索同时匹配标题与消息摘要；自动起名或 `/title` 写入后列表自动更新。当前 Thread 用浅绿背景标识，未选中仅 hover 显示轻量背景。
- **Timeline** 是扁平阅读流：角色行（小头像 + 名称 + 时间）+ 左对齐正文，无气泡卡片；思考和审批条目用 1px 边框表达结构。视口贴底时自动跟随新消息；手动上滚时保持位置并浮出「回到底部」按钮，上滚期间有新内容则升级为「有新输出」，点击恢复跟随。工具调用默认折叠为单行（语义图标 + 动词标签 + 主参数 + 状态 + 展开箭头），展开后显示「输出」与「参数」两张卡片；输出按工具类型结构化渲染（读取文件带行号栏、列目录/搜索带文件图标清单、查找按文件分组、编辑/写入渲染红绿 diff 行、执行命令渲染为终端块并显示 exit code），其余 JSON 自动美化。写类工具用暖色图标提示副作用，失败行用淡红底 + 左侧红条 + 「失败」文字徽章。
- **Composer 底部操作条**：左端审批模式下拉（显示当前模式，点击就地切换；待处理交互或压缩中锁定，**运行中仍可改下一轮档位**）+ 工作模式 chip（未锁定提示 Tab 切换，Thread 冻结时显示锁图标与冻结模式）+ Skill chip；右端模型下拉（发送键旁，菜单底部「管理模型…」打开 Dock 的 Model 面板）。两个下拉向上弹出、形态一致。模型下拉只影响下一次 Run，语义与 `/model` 相同（见[配置页](configuration.md#在-thread-中选择模型)）。

## Composer、命令菜单与输入

- `Enter` 发送、`Shift+Enter` 换行；中文 IME 组合期间的 Enter 只确认候选，不会发送消息或选中命令（键盘状态机独立于 DOM 处理）。运行中发送按钮原位变为停止按钮（点击取消）。
- 输入 `/` 打开命令菜单（上下键 + `Enter`，`Esc` 关闭）；`Ctrl/Cmd+K` 也可打开。`//` 不打开菜单，用于发送以 `/` 开头的普通文本。命令菜单按协商 capability 隐藏不可用项（如未协商上下文管理不显示 `/compact`）；Web 与 TUI 共享同一会话，菜单**不提供 `/web`** 以避免嵌套接管。正在执行/等待交互/压缩中，受限命令会说明「当前任务结束后可用」。
- 可用的 Slash Command 清单、语义与运行中限制与 TUI 完全一致，见[工作流页 §高频 Slash Command](workflows.md#高频-slash-command)。
- 输入框为空时 `Tab` 在 Build / Compose 工作模式间切换；`Shift+Tab` 循环审批模式（Host 返回实际 `mode` 与 `revision` 后才更新界面）。

## Markdown、代码与可访问性

- Markdown 按 GFM 渲染，但 **raw HTML 永远按纯文本渲染**，不自动加载远端图片；链接只允许 `http`/`https`/`mailto`，其它协议降级为不可点击文本并保留样式标记。所有渲染零网络依赖。
- fenced code 由离线 Shiki Syntax Worker 高亮，支持 JS/TS/JSX/TSX/Python/Go/C/C++/Bash/Java/HTML/JSON/YAML/CSS/Markdown 等，语言别名（`py`、`ts`、`yml`、`sh`、`c++`）可精确识别；代码块右上角有复制按钮。标记 `diff`/`patch` 或可识别为 unified diff 的内容按行显示红删绿增并保留 hunk 上下文。**降级阈值：超过 64 KiB 或 2000 行、未知语言、Worker 连续致命故障时自动降级纯文本，复制功能始终可用**；语法资产离线打包，无运行时远程下载。
- 可访问性：键盘聚焦显示 2px 绿色 focus ring（Composer 以整卡描边变绿表达聚焦），Dock tablist、命令菜单 listbox、菜单均按 ARIA 模式实现；运行、等待、失败、取消不只依赖颜色。

## 审批、问答与文件变更 Diff

- Approval 只显示服务端允许的按钮：允许一次 / 本会话允许 / 本项目允许 / 拒绝 / 拒绝并反馈。「本会话允许」进程退出即失效；「本项目允许」写入项目 `.harness/settings.json` 持续生效（审批语义详见[安全页](terminal-and-safety.md#审批响应与规则持久化)）。Question 一次展示全部题目，单选 radio、多选 checkbox、`allowOther` 显示「其他」自由文本；必答项完成后整体提交。Approval/Question 都是页面内原生 UI，不会弹浏览器 `confirm/prompt`。
- **文件变更审批 Diff 卡**：`write_file`/`edit_file`/`delete_file` 使用专用 Diff 卡，显示逻辑路径、操作、增删统计与请求参数（默认折叠）；非文件审批继续用通用 description 与参数预览。
  - 视口宽度 ≥760px 默认左右对比（split），较窄默认行内（unified）；当前审批内可手动点「左右 / 行内」切换。
  - 删除/新增同时使用背景色与 `-`/`+` 标记，old/new 行号始终可见；长行可水平滚动，不静默省略。
  - 语法高亮复用离线 Shiki Worker；未知语言、超限、超时或 Worker 故障只关闭高亮，不影响审批。
  - **截断语义**：Diff 预览受 200 行 / 16 KiB 上限约束，截断提示显示在审批按钮之前；**批准始终针对完整拟议变更**，与 TUI 一致。
  - Diff 预览区高度上限约 240px，超出内部滚动；审批卡整体限制在工作区剩余高度内自身滚动，滚动不会把审批按钮和 Composer 推出视口。审批/问答/目录信任卡与对话内容共用同一居中内容列（封顶 880px）。
- 普通「拒绝」点击立即提交；「批准」需选择后点击「提交」确认；「拒绝并反馈」需填写反馈后提交。

来源：`packages/cli/src/presentation-coordinator/coordinator.ts`（token 轮换、65s ready、10s 重连宽限）、`packages/cli/src/web/server.ts`（token 校验、CSP）、`packages/cli/src/web/presentation/web-app.tsx`、`composer.tsx`、`file-diff-approval.tsx`、`markdown.tsx`、`work-item-view.tsx`、`workspace-sidebar/`、`context-dock/panel-common.tsx`、`styles.css`（宽度契约注释）、`packages/cli/src/web/application/adapter.ts`（宽度常量与钳制）、`packages/cli/src/web/syntax/worker.ts`（64 KiB/2000 行降级）、`packages/cli/src/presentation-shared/timeline-presenter.ts`（状态文案）、旧文档 `docs/user/Web界面.md`、`docs/user/交互使用.md`。
