/** 文件图标与安全 Markdown 预览的最小检查；先构建 @workbench/ui。 */
import assert from "node:assert/strict"
import { createRequire, register } from "node:module"
import { createElement } from "react"

// 根入口会引入 CSS；Node 冒烟时忽略样式，仍通过公开入口加载组件。
register(`data:text/javascript,${encodeURIComponent('export function load(url, context, next) { return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context) }')}`, import.meta.url)
const { fileIconFor, Markdown, ProjectFilePanel, ConversationView } = await import("@workbench/ui")
const { renderToStaticMarkup } = createRequire(new URL("../../apps/desktop/package.json", import.meta.url))("react-dom/server")
const { resolveSessionFileReference } = await import("../../apps/desktop/src/renderer/features/session/session-file-reference.ts")

assert.equal(fileIconFor("src/main.ts").type, "ts")
assert.equal(fileIconFor("test.PY").type, "python")
assert.equal(fileIconFor("constructor").type, "default")
assert.notEqual(fileIconFor("main.ts").label, fileIconFor("main.js").label)
assert.equal(fileIconFor("index.html").type, "html")
assert.equal(fileIconFor("config.json").type, "json")

assert.deepEqual(resolveSessionFileReference("README.md", "/work/project"), { path: "README.md", exact: false })
assert.deepEqual(resolveSessionFileReference("src/app.ts", "/work/project"), { path: "src/app.ts", exact: true })
assert.deepEqual(resolveSessionFileReference("/work/project/src/app.ts:20", "/work/project"), { path: "src/app.ts", exact: true, line: 20 })
assert.deepEqual(resolveSessionFileReference("file:///work/project/a%20b.md#L5", "/work/project"), { path: "a b.md", exact: true, line: 5 })
assert.deepEqual(resolveSessionFileReference("C:\\Work\\Project\\src\\app.ts", "c:\\work\\project"), { path: "src/app.ts", exact: true })
assert.deepEqual(resolveSessionFileReference("/README.md:34", "/Users/demo/Lumno"), { path: "README.md", exact: true, line: 34 })
assert.deepEqual(resolveSessionFileReference("/src/index.ts:10-25", "/Users/demo/Lumno"), { path: "src/index.ts", exact: true, line: 10, endLine: 25 })
assert.deepEqual(resolveSessionFileReference("README.md#L8-L12", "/Users/demo/Lumno"), { path: "README.md", exact: false, line: 8, endLine: 12 })
for (const unsafe of ["../secret.ts", "%2e%2e/secret.ts", "/work/project-other/secret.ts", ".git/config", "file://other/work/project/a.ts", "javascript:alert.ts"]) {
  assert.equal(resolveSessionFileReference(unsafe, "/work/project"), null, unsafe)
}
for (const unsafe of ["/Users/other/README.md", "/etc/passwd", "file:///README.md"]) {
  assert.equal(resolveSessionFileReference(unsafe, "/Users/demo/Lumno"), null, unsafe)
}

const message = renderToStaticMarkup(createElement(Markdown, { text: "`src/main.ts` 和 `const x = 1`" }))
assert.match(message, /markdown-file-reference[^>]*>.*wb-file-type-icon-ts/)
assert.equal((message.match(/markdown-file-reference/g) ?? []).length, 1)
const clickable = renderToStaticMarkup(createElement(Markdown, {
  text: "`src/main.ts`、[文档](docs/a%20b.md#L5) 和 [不安全](javascript:alert.js)",
  actions: { openFile: async () => {} },
}))
assert.match(clickable, /aria-label="打开文件 src\/main.ts"/)
assert.match(clickable, /aria-label="打开文件 docs\/a%20b.md#L5"/)
assert.doesNotMatch(clickable, /aria-label="打开文件 javascript:/)

const timeline = renderToStaticMarkup(createElement(ConversationView, {
  scope: { namespace: "test", accountId: "a", workspaceId: "w", conversationId: "c" }, visible: true, contentRevision: 1,
  entries: [{ kind: "tool", id: "tool", label: "读取文件", status: "completed", tone: "read", detail: { blocks: [{ kind: "paths", paths: ["src/main.ts"] }] } }],
  personal: { scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null }, expandedTools: ["tool"], expandedOutputs: [], draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] }, interactions: {} },
  composer: { send: { enabled: false }, cancel: { enabled: false }, primaryActions: "none", commands: [], controls: [], projectTarget: null, references: [], attachments: [] },
  interaction: null, actions: { onPersonalChange() {}, rendering: { openFile: async () => {} } },
}))
assert.match(timeline, /aria-label="打开文件 src\/main.ts"/)

const content = "# 文件标题\n\n**正文**\n\n<script>alert(1)</script>"
const panel = (path, language) => renderToStaticMarkup(createElement(ProjectFilePanel, {
  scope: {}, path, view: { status: "ready", file: { path, language, content, sizeBytes: 60, lineCount: 5 } },
  refresh: { enabled: true }, onRefresh() {}, active: true, tabId: "tab", panelId: "panel",
}))
const markdown = panel("README.md", "markdown")
assert.match(markdown, /aria-label="Markdown 显示方式"/)
assert.match(markdown, /<h2>.*文件标题.*<\/h2>/)
assert.match(markdown, /&lt;script&gt;/)
assert.doesNotMatch(markdown, /<script>/)
const source = panel("example.txt", null)
assert.match(source, /project-file-code-pre/)
assert.doesNotMatch(source, /Markdown 显示方式/)

const targeted = renderToStaticMarkup(createElement(ProjectFilePanel, {
  scope: {}, path: "README.md", view: { status: "ready", file: { path: "README.md", language: "markdown", content, sizeBytes: 60, lineCount: 5 } },
  refresh: { enabled: true }, onRefresh() {}, active: true, tabId: "tab", panelId: "panel",
  preview: false, targetLine: { line: 2, endLine: 3, seq: 1 },
}))
assert.match(targeted, /project-line-number is-target/)
assert.match(targeted, /has-target-line/)

const taskList = renderToStaticMarkup(createElement(Markdown, { text: "- [x] 校验请求号\n- [ ] 补充测试" }))
assert.equal((taskList.match(/type="checkbox"/g) ?? []).length, 2)

console.log("文件图标、引用与 Markdown 预览检查通过")
