# HC-183 全屏 TUI 视觉重构执行清单

关联：[Task](../task/HC-183-全屏TUI视觉重构.md) · [Spec](../spec/HC-183-全屏TUI视觉重构.md) · [Plan](../plan/HC-183-全屏TUI视觉重构.md)

执行规则：实现阶段使用 `test-driven-development`，先写最小失败测试，再写最小实现。一次只推进到下一个“可演示停点”；完成该节后勾选、记录命令与结果、更新 `tmp/handoff.md`，立即停止等待用户查看。不得跨停点连续执行。

## 0. 开工与基线

- [x] **认领 HC-183**：运行 `npm run task:claim -- HC-183 --owner <名称> --branch feat_hc_183_全屏TUI视觉重构`；确认 Task 为进行中且当前分支一致。
- [x] **确认工作区边界**：运行 `git status --short`，记录并保留用户已有改动；读取 Task / Spec / Plan / Todo、`docs/developer/architecture/TUI表现层.md` 与 `tmp/handoff.md`。
- [x] **记录基线**：运行现有 TUI focused tests、`npm run typecheck` 与 `npm run build`；把现有失败或 sandbox 限制写入 handoff，不把环境失败当代码缺陷。
- [ ] **建立视觉 fixture 清单**：固定 welcome、conversation、streaming、tool、approval、menu、overlay、too-small 的无凭据 fixture；完成信号是后续帧测试无需调用真实模型。

## 1. WP1 — TerminalSession 生命周期

- [x] **先写 enter/close 失败测试**：覆盖 alternate screen、cursor、mouse reporting、raw mode、listener 的成功顺序和每步失败后的逆序恢复；期望测试先失败。
- [x] **实现最小 `TerminalSession`**：依赖通过 stream/callback 注入，只暴露 enter/subscribe/close 等小 interface；完成信号是所有 ANSI 只从该 Module 输出。
- [x] **补幂等与非 TTY**：覆盖部分 enter、重复 close、重复信号、non-TTY、listener 清理；完成信号是任何路径都不抛二次恢复错误。
- [x] **补 resize/wheel 解码**：只产生 resize 与 wheel 语义事件，畸形/部分 mouse sequence 被忽略且不进入 InputBuffer。
- [x] **Focused verification**：运行 TerminalSession focused tests 与现有 input/ink-root tests；记录命令、通过数和未运行项。

## 2. WP2 — TimelineViewport 纯状态

- [x] **先写滚动状态失败测试**：PageUp/PageDown、Ctrl+Home/End、follow-tail、滚离底部、新内容计数、回到底部清零。
- [x] **实现稳定 anchor**：使用 entry id + entry 内位置，不把物理行号写入 TuiAdapter；完成信号是 prepend/stream/resize 不丢阅读位置。
- [x] **补 cell-width 与尺寸门禁**：40/72/120 列、12/17/24 行、中文/emoji/组合字符、负尺寸 clamp、too-small。
- [x] **补 BottomArea/resize 行为**：输入高度、菜单或 Interaction 高度变化后视口仍保留 anchor；follow-tail 保持最后一行可见。
- [x] **Focused verification**：运行 viewport tests；空、单条、长 Thread 与 streaming fixtures 全部通过。

## 3. WP3 — 唯一全屏根

- [ ] **先写全屏 root 失败测试**：mount 前 enter、finally close、render error、Ctrl+C、SIGINT/SIGTERM、Web handoff close、too-small 与 resize 恢复。
- [x] **接入 `runTui()`**：创建唯一 TerminalSession，并在同一 finally 恢复；React effect 只订阅事件，不成为最终恢复 owner。
- [x] **接入稳定四槽布局**：Header / TimelineViewport / BottomArea / Footer；先复用现有 Timeline/InputBar 内容，输入固定在底部。
- [x] **接入滚动 owner 优先级**：菜单、Interaction、Overlay 先消费；否则 PageUp/PageDown、Ctrl+Home/End 与 wheel 进入 viewport；普通方向键/Home/End 留给输入。
- [x] **替换旧 Static 路径**：删除 `TimelineProjector`、`Static` 和对应死测试/调用；仓库只剩全屏 canonical Renderer。
- [x] **接入新内容提示与尾随恢复**：滚离底部不抢位置，提交 Prompt、切 Thread 或显式到底部恢复 follow-tail。
- [ ] **Focused verification**：运行 root、shortcut、input、web-handoff tests，`npm run typecheck`；真实终端验证进入、resize、滚动与退出。

## 可演示停点 A — 全屏骨架与历史滚动

自动化证据（2026-09-18）：`npm run test:ts -- --run packages/cli/tests/tui` 通过 12 files / 88 tests；`npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check` 通过。当前运行器不被 CLI 识别为真实终端，以下实机项保留未勾选，等待用户验收。

- [ ] `npm run dev` 进入 alternate screen，输入区固定在底部，退出恢复原 Shell。
- [ ] PageUp/PageDown、Ctrl+Home/End 与鼠标滚轮能浏览已有历史。
- [ ] 滚离底部后新输出不改变位置，显示新内容提示；回到底部后恢复尾随。
- [ ] 40、72、120 列正常重排；小于 40×12 显示可退出的终端过小提示。
- [ ] 正常退出、Ctrl+C 与 SIGTERM 均恢复光标、输入回显和鼠标模式。
- [ ] 将 focused tests、实机结果和已知终端差异写入 Task / `tmp/handoff.md`，停止等待用户确认。

## 4. WP4 — Theme、Header、欢迎页与 Footer

- [x] **先写 theme/响应式失败测试**：禁止 Ink 生产组件散落 raw color；Header/Footer 在 40/72/120 列按优先级隐藏。
- [x] **收敛 `tuiTheme`**：保留唯一 brand/mode/text/selection/semantic/tool token；删除失效或重叠 token并迁移调用方。
- [x] **实现单行 Header**：Harness/Thread、mode、model、workspace、特殊状态按优先级展示，绝不换成多行。
- [x] **实现欢迎页**：Timeline 为空时显示版本、workspace、model、mode 和不超过三个真实入口；无大幅 ASCII/Feed。
- [x] **实现响应式 Footer**：compact 仅保留活动状态和必要提示，短高度允许隐藏 Footer，不隐藏 Interaction。
- [ ] **Focused verification**：theme tests 与 40/72/120 welcome/header/footer frames 通过；浅色/深色终端完成肉眼检查。

## 5. WP5 — InputBar、菜单、Picker 与 Toast

- [x] **先写底部槽位失败测试**：菜单/Toast 开关不改变 Timeline anchor；InputBar 最多 6 个视觉行；选中态不只依赖 inverse。
- [x] **重做 InputBar chrome**：使用当前模式主题色边框，只保留正文和有界帮助，不重复 Header/Footer 的模式与工作区信息；保留 Unicode、多行、history、slash/@、submit/cancel 语义。
- [x] **统一 Menu/Picker shell**：Command、mention、Skill、Thread、Model、Agent、Undo 共用行高、选中态、空态、截断和 Footer。
- [x] **固定 Toast 槽位**：Toast 覆盖显示，不插入 Timeline、不挤压 BottomArea；variant 使用 semantic token + 文案。
- [x] **Focused verification**：input-buffer、menus、toast timer、BottomArea/anchor integration tests 通过。

## 可演示停点 B — 完整全屏外壳

- [ ] 空 Thread 的欢迎页、Header、InputBar、Footer 信息克制且层级清楚。
- [ ] `/`、`@`、Thread/Model/Skill/Undo Picker 的菜单、选中态和空态统一。
- [ ] Build/Compose 与审批模式只在对应位置使用 mode/semantic 色。
- [ ] 40、72、120 列 resize 时 Header/Footer 主动降级，输入与菜单仍可用。
- [ ] Toast 不推动历史或输入区。
- [x] 更新 Todo、Task 证据和 `tmp/handoff.md`，停止等待用户确认。

自动化证据（2026-09-20）：TDD 新增窄屏欢迎页、长 Unicode 单行光标、长确认 Dialog、目录遮蔽风险提示回归；用户实机反馈输入边界不清后，补充 Build/Compose 同色圆角边框回归且仍保持最多 6 行；进一步按反馈删除输入框内与 Header/Footer 重复的模式、输入模式和工作区信息。`npm exec vitest -- run --config ../../vitest.config.ts tests/tui` 通过 13 files / 99 tests，`npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check` 通过。浅色/深色主题、真实 resize 与其余交互观感保留给用户实机验收。

## 6. WP6 — FullscreenProjection 与工具分组

- [x] **先写投影失败测试**：稳定 id、无输入 mutation、中文标签、Reasoning 折叠、Interaction 结果和各类 TimelineItem。
- [x] **实现纯 `projectFullscreenTimeline()`**：不 import React/Ink/stream，不 dispatch intent；重复输入得到确定性结果。
- [x] **实现只读 Tool Group 白名单**：只合并同 run/execution/activity、连续、已完成的 read/search/list。
- [x] **实现不可合并门禁**：write/edit/delete/execute/task、running/failed、未知 MCP/Plugin、安全交互工具全部独立。
- [x] **保留详情身份**：Group 保存原始 tool ids，Tool Inspector/展开详情仍可达。
- [x] **Focused verification**：普通/恢复/child/compose fixtures 通过，`presentation-shared` 复用证据明确。

## 7. WP7 — 类型化 Timeline 与活动反馈

- [x] **先写视觉结构失败测试**：用户、Assistant、Reasoning、Tool Group、独立 Tool、Interaction、Compose、Goal、child timeline。
- [x] **替换日志式 `TimelineLine`**：删除 `You:`、`Harness:`、`Reasoning:`、`Tool:`、raw enum；使用稳定 gutter、缩进和中文状态。
- [x] **接入 active-only spinner**：固定宽度；running/streaming 活动，completed/failed 历史静止。
- [x] **接入有界嵌套输出**：工具结果、diff、失败/取消均有 glyph + 文案，不能只靠颜色。
- [x] **补 fake-timer 回归**：完成历史帧随时间不变化，只有当前活动项重绘。
- [x] **Focused verification**：streaming→final、tool running→completed/failed、child/compose/goal frames 通过。

## 8. WP8 — Markdown 与长内容

- [x] **先写 Markdown 失败测试**：heading、emphasis、inline/fenced code、list、blockquote、link、table、解析失败。
- [x] **实现终端层级**：heading/段落留白、代码语言与有界正文、link 标签+URL、blockquote/list gutter。
- [x] **实现 table 响应式**：wide/standard 对齐，compact 纵向 key/value 降级。
- [x] **补 cell-width 与安全降级**：中文/emoji/组合字符、长 URL/代码不撑破 viewport；Shiki 失败纯文本可读且无网络。
- [x] **Focused verification**：40/72/120 Markdown fixtures 与现有 markdown tests 通过。

## 可演示停点 C — 可扫描的对话与工具活动

- [ ] 一段包含普通消息、流式回答、思考、读取、搜索、写文件、Shell、子代理和失败工具的会话层级清楚。
- [ ] 连续只读工具被压缩；写入/Shell/失败/子代理保持独立且详情可查。
- [ ] 当前活动项有反馈，完成历史完全静止。
- [ ] 标题、列表、引用、代码、链接和表格在 40/72/120 列可读。
- [x] 更新 Todo、Task 证据和 `tmp/handoff.md`，停止等待用户确认。

自动化证据（2026-09-20）：新增 FullscreenProjection、只读 Tool Group、类型化主时间线、活动行局部 spinner 与终端 Markdown 纯投影；复审补齐分组后 viewport anchor、ANSI/OSC/C0/C1 清理、超宽表格无损降级和 spinner 不重投影历史。`npm run test:ts -- --run packages/cli/tests/tui` 通过 16 files / 119 tests，`npm run typecheck`、`npm run build`、`npm run project:check`、`git diff --check` 通过。真实混合会话与 40/72/120 列观感仍待用户 TTY 验收。

## 9. WP9 — Interaction 统一

- [x] **先写每类 Interaction 失败测试**：Approval、Directory Trust、Question、Plan、Goal 的内容、选项、按键和 compact frame。
- [x] **建立共享 BottomArea shell**：统一标题、描述、options、selection、Footer 和强边界，不复制决策逻辑。
- [x] **按风险展示正文**：文件 mutation 显示 path/diff；Shell 显示命令；Directory Trust 显示目录/遮蔽；Question/Plan/Goal 保留输入与进度。
- [x] **保持 policy 决策集合**：不得新增、删除、重排或自动选择安全决定。
- [x] **压缩历史结果**：resolved Interaction 只留中文结果摘要，不重复完整 pending panel。
- [x] **Focused verification**：所有 Interaction 键盘路径、40×12 与 72×24 frames 通过。

## 10. WP10 — Overlay 与 Web handoff

- [x] **先写 Overlay owner 失败测试**：最上层滚轮/按键、Esc 返回、draft/anchor/follow-tail 保持。
- [x] **统一 Overlay shell**：Workspace、Status、BTW、Inspect、Tool Inspector、文件预览共用 title/body/footer、空态和错误态。
- [x] **保留现有能力**：Workspace/文件预览键盘导航和 `@` 插入；Tool Inspector 原始详情；BTW copy 现有语义。
- [x] **接入 Web handoff 全屏状态页**：web active 冻结 Timeline，return 后同一 TerminalSession 原地恢复。
- [x] **Focused verification**：temporary-view、menus、workspace、tool inspector、web-handoff、overlay wheel/anchor tests 通过。

## 11. WP11 — 响应式与长内容回归

- [x] **帧矩阵**：为 welcome、conversation、streaming、tool group、Interaction、menu、Overlay、too-small 建立 40/72/120 × 12/17/24 代表帧。
- [x] **Unicode/长内容矩阵**：长 Thread、长路径、长命令、中文、emoji、组合字符、多行输入与新内容提示无越界。
- [x] **fixture 收敛**：复用现有 TUI test helper 表达结构、行数、顺序和可见文案，不建立产品态 visual-test framework。
- [x] **Focused verification**：完整视觉帧 suite 通过，记录三种宽度的真实终端截图/录屏。

## 12. WP12 — 终端恢复与长会话性能

- [x] **生命周期矩阵**：enter 每个失败点、render error、Ctrl+C、SIGINT/SIGTERM、sidecar close、Web handoff close 均恢复终端。
- [x] **长会话性能证据**：固定长 Thread + streaming fixture，证明活动更新不对全部历史做无界昂贵解析；记录测试口径和结果。
- [x] **针对 seam 修复**：恢复缺陷只修改 TerminalSession，重排缺陷只修改 Projection/Viewport；不得在测试中放宽 invariant。
- [x] **Focused verification**：terminal lifecycle suite、性能 fixture 与真实终端异常退出检查通过。

## 13. WP13 — 旧路径清理与完整 TUI 回归

- [x] **删除旧路径**：清理 Static projector、raw color、旧测试、死 import 和 fallback；全仓无主屏滚屏 canonical 实现。
- [x] **交互回归**：Slash/@、Picker、Undo、Workspace、Tool Inspector、Interaction、child timeline 与 Web handoff focused suites 通过。
- [x] **Focused verification**：完整 TUI suite、`npm run typecheck`、`npm run build` 通过；全仓搜索无旧 canonical 标识。

## 14. WP14 — 文档与项目级验收

- [x] **用户文档**：更新 `docs/user/交互使用.md` 的全屏、滚动、退出、复制、too-small、Overlay；更新故障排查的恢复和鼠标兼容说明。
- [x] **架构文档**：重写 `TUI表现层.md` 的 Ink 全屏路径，删除 OpenTUI/主屏 scrollback/Sidebar canonical 描述；增量更新 `架构总览.md`。
- [ ] **任务证据**：把各停点截图/录屏、focused tests、实机终端与已知限制写回 Task；版本影响明确记录。
- [ ] **项目级检查**：运行 `npm run project:check`、`npm run typecheck`、`npm run test`、`npm run build`；只记录规范允许的 sandbox 跳过。
- [ ] **Review**：使用 `code-review-and-quality` 对照 Task/Spec/Todo 检查 correctness、终端恢复、交互回归、响应式、性能和文档；结论写回 Task。
- [ ] **完成归档**：用户验收后运行 `npm run task:complete -- HC-183 --evidence "<命令与结果>"`，确认 Task 移入 archive、看板同步，并检视架构文档无并行旧结论。

## 可演示停点 D — 完整全屏 TUI 验收

- [ ] 真实终端走完欢迎页 → 对话 → 工具 → 审批/问答 → Workspace/Tool Inspector → Web handoff 返回 → 退出。
- [ ] 同一会话在 40、72、120 列与短高度下响应式可读。
- [ ] 键盘和鼠标滚轮浏览、暂停尾随、新内容提示、回到底部均符合 Spec。
- [ ] 终端原生方式可选择当前可见文本，TUI 不自动复制、不响应点击/hover。
- [ ] 正常退出、Ctrl+C、SIGTERM 后原 Shell、光标、回显和鼠标模式恢复。
- [ ] 用户确认停点 D 后，才允许执行最终 Review 和 Task 完成归档。
