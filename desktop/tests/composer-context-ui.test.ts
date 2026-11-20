/** 输入区双层上下文壳、`+` 添加上下文菜单与文件附件能力的单元测试与 SSR 渲染断言。 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AnnotatedUserMessage } from "../src/ui/conversation/annotations.tsx"
import { ConversationComposer } from "../src/ui/conversation/composer.tsx"
import { ConversationTimeline } from "../src/ui/conversation/timeline.tsx"
import {
  applyLeadingSlashCommand,
  insertMentionTrigger,
  mergeAttachmentPaths,
  removeLeadingCommandOnBackspace,
  splitComposerHighlightSegments,
} from "../src/ui/conversation/mention-policy.ts"
import type { ConversationComposerView, ConversationDraft } from "../src/ui/conversation/types.ts"
import {
  buildDirectoryContextView,
  handleDirectoryContextAction,
} from "../src/renderer/features/session/session-model.ts"

const testScope = { namespace: "test", accountId: "u-1", workspaceId: "w-1", conversationId: "c-1" }

const baseDraft = (overrides: Partial<ConversationDraft> = {}): ConversationDraft => ({
  text: "",
  selectionStart: 0,
  selectionEnd: 0,
  revision: 0,
  referenceIds: [],
  attachmentIds: [],
  ...overrides,
})

const baseModel = (overrides: Partial<ConversationComposerView> = {}): ConversationComposerView => ({
  primaryActions: "send",
  send: { enabled: true },
  cancel: { enabled: false },
  commands: [],
  controls: [],
  projectTarget: { deviceId: "u-1", projectId: "p-1" },
  references: [],
  attachments: [],
  ...overrides,
})

test("insertMentionTrigger 在不同光标上下文正确插入 @ 并保留词元识别", () => {
  assert.deepEqual(insertMentionTrigger("", 0, 0), { text: "@", cursor: 1 })
  assert.deepEqual(insertMentionTrigger("hello", 0, 0), { text: "@hello", cursor: 1 })
  assert.deepEqual(insertMentionTrigger("请查看 ", 4, 4), { text: "请查看 @", cursor: 5 })
  assert.deepEqual(insertMentionTrigger("请查看", 3, 3), { text: "请查看 @", cursor: 5 })
  assert.deepEqual(insertMentionTrigger("check file", 5, 5), { text: "check @ file", cursor: 7 })
  assert.deepEqual(insertMentionTrigger("请看这里和那里", 2, 5), { text: "请看 @那里", cursor: 4 })
})

test("mergeAttachmentPaths 合并追加本机文件或目录并去重", () => {
  assert.deepEqual(mergeAttachmentPaths([], ["/tmp/a.ts"]), ["/tmp/a.ts"])
  assert.deepEqual(
    mergeAttachmentPaths(["/tmp/a.ts", "/tmp/dir/"], ["/tmp/dir/", "/tmp/b.md", ""]),
    ["/tmp/a.ts", "/tmp/dir/", "/tmp/b.md"],
  )
})

test("splitComposerHighlightSegments、removeLeadingCommandOnBackspace 与 applyLeadingSlashCommand 正确处理命令块与提及", () => {
  assert.deepEqual(splitComposerHighlightSegments("/goal 请查看 @src/app.tsx"), [
    { kind: "command", text: "/goal" },
    { kind: "plain", text: " 请查看 " },
    { kind: "mention", text: "@src/app.tsx" },
  ])
  assert.deepEqual(splitComposerHighlightSegments("/go"), [{ kind: "plain", text: "/go" }])
  assert.deepEqual(splitComposerHighlightSegments("/goal", { includeBareLeadingCommand: true }), [
    { kind: "command", text: "/goal" },
  ])
  assert.deepEqual(splitComposerHighlightSegments("/goal", { commandIds: ["goal", "plan"] }), [
    { kind: "command", text: "/goal" },
  ])
  assert.deepEqual(splitComposerHighlightSegments("/Users/dev/a.ts", { includeBareLeadingCommand: true }), [
    { kind: "plain", text: "/Users/dev/a.ts" },
  ])
  assert.deepEqual(splitComposerHighlightSegments("// comment", { includeBareLeadingCommand: true }), [
    { kind: "plain", text: "// comment" },
  ])
  assert.deepEqual(splitComposerHighlightSegments("联系 a@example.com 查看"), [
    { kind: "plain", text: "联系 a@example.com 查看" },
  ])

  assert.deepEqual(removeLeadingCommandOnBackspace("/goal hello", 6, 6), { text: "hello", cursor: 0 })
  assert.deepEqual(removeLeadingCommandOnBackspace("/goal hello", 5, 5), { text: "hello", cursor: 0 })
  assert.deepEqual(removeLeadingCommandOnBackspace("  /plan arg", 8, 8), { text: "  arg", cursor: 2 })
  assert.equal(removeLeadingCommandOnBackspace("/goal hello", 11, 11), null)
  assert.equal(removeLeadingCommandOnBackspace("/goal", 5, 5), null)
  assert.equal(removeLeadingCommandOnBackspace("/goal hello", 5, 6), null)

  assert.deepEqual(applyLeadingSlashCommand("", "goal"), { text: "/goal ", cursor: 6 })
  assert.deepEqual(applyLeadingSlashCommand("/go", "goal"), { text: "/goal ", cursor: 6 })
  assert.deepEqual(applyLeadingSlashCommand("/goal arg1", "plan"), { text: "/plan arg1", cursor: 6 })
  assert.deepEqual(applyLeadingSlashCommand("帮我审查代码", "review"), { text: "/review 帮我审查代码", cursor: 8 })
  assert.deepEqual(applyLeadingSlashCommand("/Users/dev/a.ts", "goal"), { text: "/goal /Users/dev/a.ts", cursor: 6 })
})

test("buildDirectoryContextView 与 handleDirectoryContextAction 正确构造菜单并分发动作", () => {
  const { directory, recentById } = buildDirectoryContextView({
    directoryPath: "/work/harness-code",
    recentDirectories: ["/work/other", "/work/harness-code", "/work/third"],
    statusLabel: "待确认",
    statusTone: "warning",
    quickAction: { id: "confirm", label: "确认目录", availability: { enabled: true } },
    confirmItem: { label: "确认并授权此目录", availability: { enabled: true } },
    switchingAvailability: { enabled: true },
    canCopyPath: true,
  })

  assert.equal(directory.label, "harness-code")
  assert.equal(directory.statusLabel, "待确认")
  assert.equal(directory.quickAction?.id, "confirm")
  assert.equal(directory.items[0]?.id, "confirm")
  assert.equal(directory.items[1]?.label, "harness-code")
  assert.equal(directory.items[1]?.active, true)
  assert.equal(directory.items[2]?.label, "other")
  assert.equal(directory.items[3]?.label, "third")
  assert.equal(directory.items[4]?.id, "copy-path")
  assert.equal(directory.items[5]?.id, "choose")

  const calls: string[] = []
  for (const id of ["confirm", "recent:0", "recent:1", "copy-path", "choose"]) {
    handleDirectoryContextAction({
      itemId: id,
      directoryPath: "/work/harness-code",
      recentById,
      onConfirmDirectory: () => calls.push("confirm"),
      onChooseDirectory: () => calls.push("choose"),
      onSelectDirectory: path => calls.push(`select:${path}`),
      onCopyPath: path => calls.push(`copy:${path}`),
    })
  }
  assert.deepEqual(calls, ["confirm", "select:/work/other", "copy:/work/harness-code", "choose"])
})

test("ConversationComposer 渲染双层上下文壳、+ 菜单、Tooltip 与文件附件胶囊", () => {
  const htmlWithContext = renderToStaticMarkup(createElement(ConversationComposer, {
    scope: testScope,
    visible: true,
    model: baseModel({
      contextBar: {
        directory: {
          label: "harness-code",
          fullPath: "/Users/dev/harness-code",
          availability: { enabled: true },
          items: [{ id: "choose", label: "选择本机文件夹…", availability: { enabled: true } }],
        },
        git: {
          branch: "harness_lody",
          head: "32765c8b",
          changedCount: 3,
          availability: { enabled: true },
          items: [{ id: "open-changes", label: "在右侧查看变更", availability: { enabled: true } }],
        },
      },
      contextMenu: {
        title: "添加上下文",
        tooltip: "添加上下文",
        items: [
          { id: "files", label: "文件", icon: "file", behavior: "files", availability: { enabled: true } },
          { id: "mention", label: "提及", icon: "mention", behavior: "mention", availability: { enabled: true } },
        ],
      },
      attachments: [
        { id: "/Users/dev/notes.md", label: "notes.md", path: "/Users/dev/notes.md", kind: "file", availability: { enabled: true } },
        { id: "/Users/dev/refs/", label: "refs/", path: "/Users/dev/refs", kind: "directory", availability: { enabled: true } },
      ],
    }),
    draft: baseDraft({
      text: "/goal 检查 @src/app.tsx",
      selectionStart: 20,
      selectionEnd: 20,
      attachmentIds: ["/Users/dev/notes.md", "/Users/dev/refs/"],
    }),
    actions: { onPersonalChange() {}, onSend: async () => ({ status: "accepted" }) },
    sendBlocked: false,
    cancelBlocked: true,
    onSend() {},
    onCancel() {},
  }))

  assert.match(htmlWithContext, /class="wb-composer-shell"/)
  assert.match(htmlWithContext, /data-context-trigger="directory"/)
  assert.match(htmlWithContext, /harness-code/)
  assert.match(htmlWithContext, /data-context-trigger="git"/)
  assert.match(htmlWithContext, /harness_lody/)
  assert.match(htmlWithContext, /· 3/)
  assert.match(htmlWithContext, /class="wb-composer-add-btn"/)
  assert.match(htmlWithContext, /class="wb-composer-add-tooltip"[^>]*>添加上下文</)
  assert.match(htmlWithContext, /class="wb-composer-inline-command">\/goal<\/mark>/)
  assert.match(htmlWithContext, /class="wb-composer-inline-mention">@src\/app\.tsx<\/mark>/)
  assert.match(htmlWithContext, /class="wb-composer-attachments"/)
  assert.match(htmlWithContext, /data-kind="file" title="\/Users\/dev\/notes\.md"/)
  assert.match(htmlWithContext, /aria-label="移除 notes\.md"/)
  assert.match(htmlWithContext, /data-kind="directory" title="\/Users\/dev\/refs"/)
  assert.match(htmlWithContext, /aria-label="移除 refs\/"/)

  const htmlWithoutGit = renderToStaticMarkup(createElement(ConversationComposer, {
    scope: testScope,
    visible: true,
    model: baseModel({
      contextBar: {
        directory: {
          label: "notes-folder",
          fullPath: "/Users/dev/notes-folder",
          availability: { enabled: true },
          items: [],
        },
      },
    }),
    draft: baseDraft(),
    actions: { onPersonalChange() {}, onSend: async () => ({ status: "accepted" }) },
    sendBlocked: false,
    cancelBlocked: true,
    onSend() {},
    onCancel() {},
  }))

  assert.match(htmlWithoutGit, /class="wb-composer-shell"/)
  assert.match(htmlWithoutGit, /data-context-trigger="directory"/)
  assert.doesNotMatch(htmlWithoutGit, /data-context-trigger="git"/)

  const htmlLegacy = renderToStaticMarkup(createElement(ConversationComposer, {
    scope: testScope,
    visible: true,
    model: baseModel(),
    draft: baseDraft(),
    actions: { onPersonalChange() {}, onSend: async () => ({ status: "accepted" }) },
    sendBlocked: false,
    cancelBlocked: true,
    onSend() {},
    onCancel() {},
  }))

  assert.doesNotMatch(htmlLegacy, /class="wb-composer-shell"/)
  assert.doesNotMatch(htmlLegacy, /class="wb-composer-add-btn"/)
})

test("session-provider 顶栏不再重复渲染目录切换按钮，保留标题与运行中状态", () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, "../src/renderer/features/session/session-provider.tsx"), "utf8")
  assert.doesNotMatch(source, /\btb-dir\b/)
  assert.doesNotMatch(source, /session-directory-button/)
  assert.match(source, /className="tb-name"/)
  assert.match(source, /className="tb-state running"/)
})

test("AnnotatedUserMessage 同步渲染行首 /命令 与 @引用 块状样式且不误伤普通绝对路径", () => {
  const commandHtml = renderToStaticMarkup(createElement(AnnotatedUserMessage, {
    text: "/goal 检查 @src/app.tsx",
  }))
  assert.match(commandHtml, /class="wb-message-inline-command">\/goal<\/span>/)
  assert.match(commandHtml, /class="wb-message-inline-mention">@src\/app\.tsx<\/span>/)

  const pathHtml = renderToStaticMarkup(createElement(AnnotatedUserMessage, {
    text: "/Users/dev/a.ts",
  }))
  assert.doesNotMatch(pathHtml, /wb-message-inline-command/)
  assert.doesNotMatch(pathHtml, /wb-message-inline-mention/)
  assert.equal(pathHtml, "/Users/dev/a.ts")
})

test("ConversationTimeline 用户消息气泡保留并渲染文件与目录附件胶囊（含仅附件无正文场景）", () => {
  const htmlWithBody = renderToStaticMarkup(createElement(ConversationTimeline, {
    scope: testScope,
    visible: true,
    contentRevision: 1,
    entries: [
      {
        kind: "message",
        id: "user-with-attachments",
        role: "user",
        text: "这是什么？",
        attachments: [
          { label: "README.md", kind: "file", path: "/Users/dev/Agent-Reach/README.md" },
          { label: "docs/", kind: "directory", path: "/Users/dev/Agent-Reach/docs" },
        ],
      },
      {
        kind: "message",
        id: "user-attachments-only",
        role: "user",
        text: "",
        attachments: [{ label: "spec.md", kind: "file", path: "spec.md" }],
      },
    ],
    personal: {
      expandedTools: [],
      expandedOutputs: [],
      scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
    },
  }))

  assert.match(htmlWithBody, /class="wb-message-attachments"/)
  assert.match(htmlWithBody, /class="wb-message-attachment-chip" data-kind="file" title="\/Users\/dev\/Agent-Reach\/README\.md"/)
  assert.match(htmlWithBody, /class="wb-message-attachment-label">README\.md<\/span>/)
  assert.match(htmlWithBody, /class="wb-message-attachment-chip" data-kind="directory" title="\/Users\/dev\/Agent-Reach\/docs"/)
  assert.match(htmlWithBody, /class="wb-message-attachment-label">docs\/<\/span>/)
  assert.match(htmlWithBody, /这是什么？/)
  assert.match(htmlWithBody, /class="wb-message-attachment-label">spec\.md<\/span>/)
})
