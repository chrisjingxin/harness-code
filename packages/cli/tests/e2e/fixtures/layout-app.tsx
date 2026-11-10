/** 布局回归专用入口：真实 WebApp 与确定性内存快照，不启动 Agent 或执行 Git。 */
/** @jsxImportSource react */
/// <reference path="../../../src/web/css.d.ts" />
import { createRoot } from "react-dom/client"
import { WebApp } from "../../../src/web/presentation/web-app"
import type { WebAdapterSnapshot, WebInteractiveAdapter } from "../../../src/web/application/adapter"
import { makeCatalog, makeInteractive, makeSnapshot, makeThread } from "../../web/presentation/fixtures"
import "../../../src/web/presentation/theme.css"
import "../../../src/web/presentation/styles.css"
import "../../../src/web/presentation/workbench-views.css"
import "../../../src/web/presentation/trace/trace.css"

const query = new URLSearchParams(location.search)
const paths = ["package.json", "packages/cli/src/web/presentation/context-dock/code/long-preview-example.ts", ...Array.from({ length: 36 }, (_, i) => `file-${i}.ts`)]
const content = Array.from({ length: 180 }, (_, i) => `export const value${i} = "layout preview"`).join("\n")
const previews = Object.fromEntries(paths.map(path => [path, { status: "ready" as const, file: {
  path, name: path.split("/").at(-1)!, content, language: "typescript", sizeBytes: content.length,
  lineCount: 180, modifiedAtMs: 1, truncated: false, version: "fixture",
} }]))
let snapshot = makeSnapshot({
  theme: query.get("theme") === "dark" ? "dark" : "light",
  viewMode: query.get("view") === "trace" ? "trace" : "chat",
  contextDock: { open: true, widthPx: 340, activePanel: query.get("panel") === "changes" ? "changes" : "code",
    code: { tabs: paths.slice(0, 2).map(path => ({ path, name: path.split("/").at(-1)!, language: "typescript" })), activePath: paths[0]!, previews, previewErrors: {} } },
  workspaceTree: { status: "ready", rows: paths.map(path => ({ path, name: path.split("/").at(-1)!, kind: "file", depth: 0, expanded: false, loading: false, hasChildren: false })), selectedPath: paths[0]!, limited: false },
  interactive: makeInteractive({
    currentThreadId: "thread-1", activity: { kind: "idle" },
    catalogs: { ...makeInteractive().catalogs, threads: makeCatalog(Array.from({ length: 25 }, (_, i) => makeThread({ thread_id: `thread-${i + 1}`, title: i ? `检查工作台布局 ${i}` : "统一工作台视觉" }))) },
    timeline: [
      { type: "message", message: { id: "user", role: "user", content: "检查不同分辨率下的工作台布局。", createdAtMs: Date.now() } },
      { type: "message", message: { id: "assistant", role: "assistant", content: "保留现有对话交互，检查文件预览、Git 与轨迹面板。", createdAtMs: Date.now() } },
    ],
    git: { busy: false, error: null, result: null, repository: {
      snapshot: "layout", head: "head", branch: "trace_merge", blockedReason: null,
      upstream: { remote: "origin", branch: "trace_merge", ahead: 1, behind: 0 },
      files: paths.map(path => ({ path, oldPath: null, status: " M", fingerprint: path })),
    }, diff: { path: paths[0]!, truncated: false, text: "@@ -1,1 +1,80 @@\n-old\n" + Array.from({ length: 80 }, (_, i) => `+line ${i}`).join("\n") } },
  }),
  trace: { threadId: "thread-1", loading: false, loaded: true, hasAnyTrace: true,
    spans: ["RUN", "LLM", "TOOL"].map((type, i) => ({ traceId: "trace-1", spanId: `span-${i}`, parentSpanId: i ? "span-0" : null,
      name: i === 0 ? "run.accept" : i === 1 ? "LLM" : "read_file", type, startTime: 1000 + i * 100, endTime: 2000,
      durationMs: 1000 - i * 100, status: "SUCCESS", metadata: { input: "检查工作台", output: content }, threadId: "thread-1", raw: {} })) },
})
const listeners = new Set<(value: WebAdapterSnapshot) => void>()
const adapter: WebInteractiveAdapter = {
  getSnapshot: () => snapshot,
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  async close() {},
  async dispatch(intent) {
    if (intent.type === "draft-change") snapshot = { ...snapshot, draft: intent.value }
    if (intent.type === "workbench-file-open") snapshot = { ...snapshot, viewMode: "file", fileViews: {
      paths: snapshot.fileViews.paths.includes(intent.path) ? snapshot.fileViews.paths : [...snapshot.fileViews.paths, intent.path], activePath: intent.path,
    } }
    if (intent.type === "workbench-file-close") {
      const index = snapshot.fileViews.paths.indexOf(intent.path)
      const paths = snapshot.fileViews.paths.filter(path => path !== intent.path)
      const activePath = snapshot.fileViews.activePath === intent.path ? paths[Math.min(index, paths.length - 1)] ?? null : snapshot.fileViews.activePath
      snapshot = { ...snapshot, viewMode: !activePath && snapshot.viewMode === "file" ? "chat" : snapshot.viewMode, fileViews: { paths, activePath } }
    }
    if (intent.type === "theme-set") snapshot = { ...snapshot, theme: intent.theme }
    if (intent.type === "view-mode-set") snapshot = { ...snapshot, viewMode: intent.mode }
    if (intent.type === "settings-open") snapshot = { ...snapshot, settings: { open: true, activePanel: intent.panel ?? "models" } }
    if (intent.type === "settings-close") snapshot = { ...snapshot, settings: { ...snapshot.settings, open: false } }
    if (intent.type === "settings-panel-select") snapshot = { ...snapshot, settings: { open: true, activePanel: intent.panel } }
    if (intent.type === "dock-panel-select" || intent.type === "dock-open") snapshot = { ...snapshot, contextDock: { ...snapshot.contextDock, open: true, activePanel: intent.panel } }
    if (intent.type === "dock-close") snapshot = { ...snapshot, contextDock: { ...snapshot.contextDock, open: false } }
    if (intent.type === "dock-width-change") snapshot = { ...snapshot, contextDock: { ...snapshot.contextDock, widthPx: Math.max(330, Math.min(760, intent.widthPx)) } }
    if (intent.type === "workspace-file-tab-select" || intent.type === "workspace-file-open") snapshot = { ...snapshot, contextDock: { ...snapshot.contextDock, code: { ...snapshot.contextDock.code, activePath: intent.path } } }
    if (intent.type === "workspace-file-tab-close") {
      const code = snapshot.contextDock.code
      const tabs = code.tabs.filter(tab => tab.path !== intent.path)
      snapshot = { ...snapshot, contextDock: { ...snapshot.contextDock, code: { ...code, tabs, activePath: tabs[0]?.path ?? null } } }
    }
    for (const listener of listeners) listener(snapshot)
  },
}
createRoot(document.getElementById("root")!).render(<WebApp adapter={adapter} active />)
