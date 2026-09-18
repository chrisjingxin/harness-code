# HC-182 Node 与 Ink 运行时迁移执行清单

关联：[Task](../task/HC-182-Node与Ink运行时迁移.md) · [Spec](../spec/HC-182-Node与Ink运行时迁移.md) · [Plan](../plan/HC-182-Node与Ink运行时迁移.md)

状态：已确认、已认领，停点 A 实施中。所有 checkbox 只有在动作、focused test 和完成信号同时满足后才能勾选。完整验证命令见 Plan 第 10 节。一次只推进到下一个可演示停点；完成后更新 `tmp/handoff.md` 并停止等待用户查看。

## 执行前

- [x] **P1 认领与基线**：读取 Task/Spec/Plan/Todo 和 `git status --short`，保留用户已有改动；用当前任务命令认领 `HC-182`，分支为 `feat_hc_182_Node与Ink运行时迁移`。验证 V0；完成信号：Task/看板已同步，handoff 已写清当前改动边界。
- [x] **P2 开发依赖 preflight**：用户已确认 npm 10.9.3、Ink 6.8.0、React 19.2.6、esbuild 0.28.2、tsx 4.23.13、Vitest 4.1.8、ws 8.21.3、string-width 8.2.2、`@types/node` 20.19.35 与 `@types/ws` 8.18.1；元数据证明运行时包支持 Node 20，企业源验收由用户迁入后执行。验证 V1；完成信号：依赖清单已获用户明确确认并有事实证据。
- [x] **TDD 准备**：实施使用 `test-driven-development`；所有行为项先出现最小失败测试，不访问真实模型、公网、用户 HOME/config/credentials。完成信号：Node bin、InputBuffer、Timeline 与 Ink root 的失败测试均先稳定复现，再完成最小实现。

## 停点 A：npm/Node 启动最小 Ink 对话

依赖：执行前全部完成。对应 Plan A1～A8。

- [x] **A1 npm workspace/lock**：迁移根与 CLI manifest、精确依赖和 npm scripts，生成唯一目标 `package-lock.json`，普通 SemVer 替换 `workspace:*`。验证 V2；完成信号：npm 10.9.3 干净 `npm ci` 成功，直接依赖保持用户确认版本；企业源安装由用户迁入后复验。
- [x] **A2 Node 工程脚本/Vitest 底座**：建立 Vitest config/setup 与 tsx script runner；迁移 task/docs/protocol、args/index/runtime-binding/diagnostic 代表性 tests。验证 V3；完成信号：Node 20 下项目检查、17 个工程测试和 115 个 CLI 测试通过。
- [x] **A3 Node bin/path/diagnostic**：先写 Node<20、help/version、source/dist/中文路径和 runtime diagnostic 失败测试，再拆 `bin.ts`/`index.ts`、统一 URL→path helper。验证 V4；完成信号：Node 19 在动态加载前失败；Node 20 的 npm bin symlink、help/version 与中文安装根测试通过。
- [x] **A4 esbuild 构建**：先写 dist/manifest/production dependency 失败测试，再实现 Node20 ESM CLI 与 Web app/CSS/worker build。验证 V5；完成信号：`npm run build` 无 Bun，连续两次 8 文件构建摘要一致（`f85080ef…53ad`），Runtime 不 import build tools。
- [x] **A5 InputBuffer reducer**：先写 ASCII/中文/emoji/ZWJ/组合字符/宽字符/CRLF/上下移动/删除/paste 失败测试，再实现 reducer 与 6 行窗口。验证 V6；完成信号：插入与删除合并 grapheme 后仍保持 seam，paste 清理控制序列且不提交。
- [x] **A6 Ink root/TerminalSize/close**：以真实 Ink render 覆盖增量输出、可见光标和无 alternate-screen 输出；用 Ink 替换 composition root，render 初始化纳入唯一 shutdown。验证 V7；完成信号：Node 20 类型/构建通过；真实仓库 PTY 启动受 sandbox 的 Thread Store 锁限制，终端恢复由用户停点演示复验。
- [x] **A7 committed/live Timeline**：先写流式→终态、恢复、重复 snapshot、1000-entry 失败测试，再实现 projector、StaticTranscript、LiveRegion。验证 V8；完成信号：真实 Ink mount 中 streaming→final 与后续消息均只进入 Static 一次，1000 条历史不重复产出。
- [x] **A8 最小 InputBar**：先写 Enter/换行 fallback/paste/history/Ctrl+C 三段/accepted-rejected 测试，再把 useInput 映射到 InputBuffer/TuiAdapter。验证 V9；完成信号：提交受理清空、拒绝保留，六行窗口与可见 grapheme 光标通过测试。
- [x] **A 停点验证**：用户确认停点 A 并要求继续停点 B。

### 停点 A 自动化证据

- Node `20.20.2`：`npm run typecheck`、`npm run build`、`npm run test:ts`（16 files / 115 tests）、`npm run test:project`（17 tests）、`npm run project:check` 全部通过。
- npm `10.9.3`：`npm ci` 成功，安装 169 packages；`npm ls --all` 无 invalid/extraneous，仅显示平台或功能型 optional dependency 未安装。
- `node node_modules/.bin/harness --version` 与 `--help` 在 Node 20 通过；真实交互 PTY 因 sandbox 内 `CHECKPOINT_MIGRATION_LOCK_UNAVAILABLE` 未完成模型对话，留给本停点用户查看。
- `npm audit` 报告 3 个 moderate advisory；涉及用户确认的 Vitest `4.1.8` 与既有 Ajv `8.17.1`，未擅自升级或执行 `audit fix`。

## 停点 B：Ink TUI 功能闭环

依赖：用户确认停点 A。对应 Plan B1～B8。

- [x] **B1 收窄 TuiAdapter**：Vitest architecture/shortcut owner 测试先失败后通过；snapshot 去掉 scrollRequest/sidebar 布局，intent 去掉 hover/sidebar-toggle，新增 workspace-open/navigate、temporary-view-close、tool-inspector-open。验证 V10。
- [x] **B2a Approval/DirectoryTrust**：Ink 内联 Panel 与 InputBar 互斥，选项来自 interaction-policy，审批 Diff 以纯文本展示。验证 V11 子集。
- [x] **B2b Question/Plan/Goal**：Question 支持选择/其他/多选，Plan/Goal 键盘决策与反馈；只读查看 Esc 关闭。验证 V11。
- [x] **B3a Command/Mention**：InlineMenus 渲染 Adapter 命令/提及 snapshot，无鼠标/绝对定位；无候选 Enter 不提交。验证 V12 子集。
- [x] **B3b Pickers/Dialog/Undo**：model/thread/skill/agent/undo 与确认框走同一内联列表，loading/empty/error 文案可见。验证 V12。
- [x] **B4a Markdown/Reasoning**：marked 映射 Ink Text；代码块固定纯文本，不初始化网络 Shiki。验证 V13 子集。
- [x] **B4b Tool/Diff**：Timeline 展示 generic Tool 有界输出；审批 Diff 用共享 unified 文本，授权不依赖高亮。验证 V13。
- [x] **B5 TemporaryView**：status/BTW/inspect 全宽分页，Esc 关闭后回到 InputBar，不重印 Static。验证 V14。
- [x] **B6 Workspace/Tool Inspector**：Ctrl+B 打开工作区键盘浏览/预览/`@` 插入；Ctrl+O 打开只读 Tool Inspector。验证 V15。
- [x] **B7 快捷键与窄终端**：Ctrl+C 清草稿优先，主时间线无 scroll owner，Toast/状态行接入 Ink；resize 只改动态区。验证 V16。
- [ ] **B8 OpenTUI 清理/TUI 回归**：OpenTUI `app.tsx` 与 `presentation/` 仍隔离在 tsconfig exclude，尚未从磁盘删除；停点 B 演示不依赖它们。验证 V17 待用户确认后做删除。
- [x] **B 停点验证**：执行 V10～V17 并复跑 V6～V9；用户已实机验证菜单/文件引用/全宽临时视图/状态/Ctrl+B/Ctrl+O/工具/审批/按键恢复全部通过。

## 停点 C：Node Web Runtime 与 handoff

依赖：用户确认停点 B。对应 Plan C1～C4。

- [x] **C1 只读 Web assets**：先写 manifest path/缺失/runtime-no-esbuild 测试，再删除 source/Bun build fallback。验证 V18；完成信号：dev/build 预生成资产，`/web` 缺资源只报错不退出 TUI。
- [x] **C2 Node HTTP server**：先迁移 Host/path/method/header/bind/stop 失败测试，再用 `node:http` 实现 loopback 静态 server。验证 V19；完成信号：只监听 127.0.0.1:0，白名单/CSP/幂等 stop 与现状一致。
- [x] **C3 ws GatewayChannel**：先迁移 Origin/token/replay/binary/oversize/close tests，再接 `ws` noServer/maxPayload/无 compression Adapter。验证 V20；完成信号：验证前不 upgrade/consume token，channel/stop 不泄漏或挂起。
- [x] **C4 Ink/Web freeze-return**：先写 web-active freeze、期间事件、return delta、timeout/reconnect/second-window tests，再保持同一 projector/root/Adapter 接 phase。验证 V21；完成信号：终端期间不刷 token，返回只补一次且 draft/Thread 保留。
- [x] **C 停点验证**：用户实机验证通过，/web 成功唤起并在浏览器中完成接管，终端冻结并可安全返回。

## 停点 D：全仓 Bun 清零与 npm 发布包

依赖：用户确认停点 C。对应 Plan D1～D4。

- [x] **D1a Project/Protocol tests**：每批最多约 5 文件，把剩余 `bun:test`/Bun mock 转 Vitest/Node，逐批 focused。验证 V22 子集；完成信号：project/protocol collection 与原用例数/语义对齐。
- [x] **D1b Interactive/IPC/Infrastructure tests**：按 5 文件批次迁移并修复真实 runner 差异，不建 shim。验证 V22 子集；完成信号：相关目录全绿，无隐式 skip。
- [x] **D1c Web tests**：按 bundle/server/presentation/syntax 分批迁移 happy-dom 和 mocks。验证 V22 子集；完成信号：Web 全套由 Vitest 收集并通过。
- [x] **D1d Acceptance/Integration/remaining TUI tests**：迁移 spawn/file/tar/installer fixture，使用编译后的 Node CLI。验证 V22；完成信号：`npm run test:ts` 全绿或仅有规则允许的宿主 skip。
- [x] **D2 工程/资源脚本 Node 化**：按批替换剩余 `Bun.write/file/spawn/spawnSync`、`import.meta.dir/main`、bunx，迁移 syntax/vendor/pack/integration harness。验证 V23；完成信号：task/version/release/protocol/resource scripts 全走 npm/tsx/node。
- [x] **D3 Bun/OpenTUI 清零门禁**：删除 manifests/lock/types/native/legacy，加入 active-path scan 并更新 dependency versions。验证 V24；完成信号：scan 零命中、仅 `package-lock.json`、`npm ls` 无 invalid/extraneous。
- [x] **D4 npm pack/隔离安装**：先写 tarball 清单、无 dev tools、临时 prefix version/headless fixture 测试，再迁移发布副本与 pack script。验证 V25；完成信号：同一 tarball 可安装运行且无联网 postinstall。
- [x] **D 停点验证**：运行 `npm ci`、typecheck、build、完整 test、project check、npm pack 和临时安装；展示零 Bun scan。更新 handoff 后，**停止等待用户查看**。

## 停点 E：企业安装、矩阵与最终验收

依赖：用户确认停点 D。对应 Plan E1～E5。

- [ ] **E1 Unix installer**：先写 Node missing/19/20/22/24、npm、registry、PATH、自检/config fixtures，再把 `install.sh` 改为 Node/npm，保留 uv/Python。验证 V26；完成信号：不下载 Node/Bun，失败不报成功。
- [ ] **E2 PowerShell installer**：同步 Node/npm 语义，先覆盖宿主、Windows ARM、global prefix、PATH、重复安装、自检。验证 V27；完成信号：Windows x64 fixture/runner 通过，无 Bun path。
- [ ] **E3 Node/platform matrix**：用同一 lock/tarball 执行 Node 20/22/24、macOS/Linux/Windows 安装/sidecar/TTY/Web smoke。验证 V28；完成信号：支持矩阵证据完整，musl/Windows ARM 只记录拒绝，跳过有明确原因。
- [ ] **E4a 用户文档**：更新 README、快速开始、交互使用、故障排查，按文档走安装/开发/输入/Workspace/Tool/Web/失败。验证 V29 子集；完成信号：用户路径无 Bun/OpenTUI/鼠标 Sidebar 陈述。
- [ ] **E4b 开发者/架构文档**：更新开发工作流、依赖清单、架构总览和 TUI 表现层，只保留 Node/npm/Ink canonical path，并引用 HC-145/181 历史。验证 V29；完成信号：文档与代码/依赖/Node20 EOL 口径一致。
- [ ] **E5 完整验证/review**：执行 V30，使用 `code-review-and-quality` 对照 Task/Spec；修复 P0/P1 并重跑受影响测试，记录版本影响和精确证据。完成信号：无未解决 P0/P1，Task 证据齐全。
- [ ] **E 停点交付**：展示安装、Node/平台矩阵、完整 TUI、Web、零 Bun、文档和 review；更新 Task/Todo/handoff，**停止等待用户最终验收**，不自动发布/提交/改版本。
- [ ] **完成与归档**：仅在用户明确验收、全部实现项/证据/review/架构/版本影响齐全后运行 task completion、移动 Task 到 archive、同步看板并复跑 project check；存在阻塞不得标完成。

## 冻结的非范围

- 不改 Python Agent、JSON-RPC、SQLite、模型、Tool、Plugin、Skill、MCP、Goal 或 Thread 业务语义。
- 不保留 Bun/OpenTUI fallback、双 lockfile、第二 Renderer、兼容 shim 或 alias。
- 不做 alternate screen、主时间线 ScrollBox、鼠标/自动选区复制、常驻 Sidebar、星空背景。
- 不做通用终端编辑器、输入选择、vim/emacs 模式或插件化 Renderer。
- 不自动下载 Node，不打自包含 Runtime，不新增 Homebrew/自更新。
- 不支持 Linux musl、Windows ARM、远程或浏览器托管终端。
- 不升级 Ink/React 主版本、不引入 Pi TUI、不重做 Web 视觉。
- 发现需要改变公开行为、依赖角色、安全或生命周期时，先修订 Task/Spec/Plan；不得在 Todo 执行中临时决定。
