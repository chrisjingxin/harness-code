/** 输入区双层上下文壳、`+` 添加上下文菜单与文件附件能力的单元测试与 SSR 渲染断言。 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationComposer } from "../src/ui/conversation/composer.tsx"
import {
  insertMentionTrigger,
  toggleAttachmentPath,
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

test("toggleAttachmentPath 支持追加、去重与二次移除", () => {
  assert.deepEqual(toggleAttachmentPath([], "src/app.tsx"), ["src/app.tsx"])
  assert.deepEqual(toggleAttachmentPath(["src/app.tsx", "src/app.tsx", "README.md"], "docs/a.md"), [
    "src/app.tsx",
    "README.md",
    "docs/a.md",
  ])
  assert.deepEqual(toggleAttachmentPath(["src/app.tsx", "README.md"], "src/app.tsx"), ["README.md"])
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
        { id: "desktop/src/ui/composer.tsx", label: "composer.tsx", path: "desktop/src/ui/composer.tsx", availability: { enabled: true } },
      ],
    }),
    draft: baseDraft({ attachmentIds: ["desktop/src/ui/composer.tsx"] }),
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
  assert.match(htmlWithContext, /class="wb-composer-attachments"/)
  assert.match(htmlWithContext, /title="desktop\/src\/ui\/composer\.tsx"/)
  assert.match(htmlWithContext, /aria-label="移除 composer\.tsx"/)

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
