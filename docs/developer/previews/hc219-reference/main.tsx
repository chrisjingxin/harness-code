/** 受控快照和内存会话用于预览 HC-219，复用桌面引用界面与公共对话组件。 */
import { useLayoutEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrandMark, ConversationView } from "@workbench/ui"
import type { ConversationActions, ConversationTimelineEntry } from "@workbench/ui"
import { EMPTY_PERSONAL_STATE, applyConversationPersonalChange } from "../../../../apps/desktop/src/renderer/features/session/index.js"
import {
  snapshotReferenceView,
  useConversationReferences,
} from "../../../../apps/desktop/src/renderer/features/collaboration/references/conversation-references.js"
import type {
  ConversationSnapshot,
  ReferenceActions,
  ReferenceResult,
  ReferenceScope,
} from "../../../../apps/desktop/src/renderer/features/collaboration/references/conversation-references.js"
import "@workbench/ui/theme.css"
import "@workbench/ui/conversation.css"
import "./preview.css"

const initialConversationId = "existing"
const sourceConversationId = "payment-discussion"
const snapshotA: ConversationSnapshot = {
  id: "payment-16-08",
  title: "支付回调的幂等规则",
  owner: "李四",
  version: "v1",
  uploadedAt: "2026-11-13 16:08",
  rangeLabel: "第 3–5 条消息",
  text: "支付回调重复到达时，按支付请求 ID 查找首次处理结果，直接返回已有结果。\n遇到超时先查订单状态，再决定是否重试。",
}
const snapshotB: ConversationSnapshot = {
  ...snapshotA,
  id: "payment-16-20",
  version: "v2",
  uploadedAt: "2026-11-13 16:20",
  rangeLabel: "第 3–7 条消息",
  text: `${snapshotA.text}\n回调重试间隔使用支付服务返回的建议值。`,
}
const earlierMaterial: ConversationSnapshot = {
  id: "existing-context",
  title: "订单接口约定",
  owner: "张三",
  version: "v1",
  uploadedAt: "2026-11-13 15:52",
  rangeLabel: "第 1 条消息",
  text: "订单查询接口保留当前响应结构。",
}
const snapshotById = new Map([snapshotA, snapshotB, earlierMaterial].map(snapshot => [snapshot.id, snapshot]))
const initialText = "帮我梳理支付回调的重试边界。"
const enabled = { enabled: true }
const disabled = { enabled: false }

type Session = {
  id: string
  title: string
  directory: string
  personal: typeof EMPTY_PERSONAL_STATE
  entries: readonly ConversationTimelineEntry[]
}

const initialSessions: readonly Session[] = [{
  id: initialConversationId,
  title: "支付回调实现",
  directory: "/示例/订单服务",
  personal: {
    ...EMPTY_PERSONAL_STATE,
    draft: {
      ...EMPTY_PERSONAL_STATE.draft,
      text: initialText,
      selectionStart: initialText.length,
      selectionEnd: initialText.length,
      referenceIds: [earlierMaterial.id],
    },
  },
  entries: [{
    kind: "message",
    id: "existing-message",
    role: "assistant",
    text: "我已列出回调的处理顺序。接下来可以核对重复回调和超时后的重试条件。",
  }],
}]

function Preview() {
  const [sessions, setSessions] = useState(initialSessions)
  const latestSessions = useRef(sessions)
  const [currentId, setCurrentId] = useState(initialConversationId)
  const nextConversation = useRef(1)
  const [sent, setSent] = useState(0)
  const [directoryReply, setDirectoryReply] = useState<((path: string | null) => void) | null>(null)
  const current = sessions.find(session => session.id === currentId) ?? sessions[0]
  const scope = {
    namespace: "hc219-preview",
    accountId: "zhang-san",
    workspaceId: "demo-team",
    projectId: "demo-project",
    deviceId: "demo-device",
    conversationId: current.id,
  } satisfies ReferenceScope

  function install(session: Session): void {
    const present = latestSessions.current.some(item => item.id === session.id)
    latestSessions.current = present
      ? latestSessions.current.map(item => item.id === session.id ? session : item)
      : [...latestSessions.current, session]
    setSessions(latestSessions.current)
  }

  const onPersonalChange: NonNullable<ConversationActions["onPersonalChange"]> = (origin, change) => {
    const session = latestSessions.current.find(item => item.id === origin.conversationId)
    if (session) install({ ...session, personal: applyConversationPersonalChange(session.personal, change) })
  }

  const referenceActions: ReferenceActions = {
    async readSnapshot(_scope, request) {
      if (request.kind === "preview" && request.conversationId === sourceConversationId) return { ok: true, value: snapshotA }
      if (request.kind === "refresh") {
        const material = request.referenceId === snapshotA.id ? snapshotB : snapshotById.get(request.referenceId)
        if (material) return { ok: true, value: material }
      }
      return { ok: false, message: "示例快照不可用。" }
    },
    chooseDirectory() {
      return new Promise<ReferenceResult<string | null>>(resolve => {
        setDirectoryReply(() => (path: string | null) => resolve({ ok: true, value: path }))
      })
    },
    async applyDraft(origin, change) {
      const targetId = change.kind === "add" && change.target.kind === "existing" ? change.target.conversationId : origin.conversationId
      const target = change.kind === "add" && change.target.kind === "new"
        ? { id: `new-${nextConversation.current++}`, title: "新会话", directory: change.target.directory, personal: EMPTY_PERSONAL_STATE, entries: [] }
        : latestSessions.current.find(item => item.id === targetId)
      if (!target) return { ok: false, message: "目标会话不可用。" }

      const previous = target.personal.draft.referenceIds
      if (change.kind === "replace" && !previous.includes(change.referenceId)) {
        return { ok: false, message: "原引用已移除，请重新选择。" }
      }
      const ids = change.kind === "add" ? [...previous, change.snapshot.id]
        : change.kind === "replace" ? previous.map(id => id === change.referenceId ? change.snapshot.id : id)
        : previous.filter(id => id !== change.referenceId)
      const personal = applyConversationPersonalChange(target.personal, { kind: "draft-references", referenceIds: [...new Set(ids)] })
      install({ ...target, personal })
      return { ok: true, value: { conversationId: target.id, draftRevision: personal.draft.revision } }
    },
    async locateConversation(_scope, conversationId) {
      if (!latestSessions.current.some(item => item.id === conversationId)) return { ok: false, message: "目标会话不可用。" }
      setCurrentId(conversationId)
      return { ok: true, value: null }
    },
  }
  const references = useConversationReferences(scope, sessions, referenceActions)

  return (
    <main className="hc219-preview">
      <header className="hc219-preview-header">
        <BrandMark />
        <h1>会话引用预览</h1>
        <p>示例发送回调 <output aria-label="发送回调次数">{sent}</output> 次</p>
      </header>
      <section className="hc219-preview-session" aria-label="当前本人会话">
        <h2>{current.title}</h2>
        <p>工作目录 <span>{current.directory}</span></p>
      </section>
      <ConversationView
        scope={scope}
        visible
        entries={current.entries}
        contentRevision={current.entries.length}
        composer={{
          send: enabled,
          cancel: disabled,
          primaryActions: "send",
          commands: [],
          controls: [],
          projectTarget: null,
          references: current.personal.draft.referenceIds.flatMap(id => {
            const snapshot = snapshotById.get(id)
            return snapshot ? [snapshotReferenceView(snapshot)] : []
          }),
          attachments: [],
        }}
        interaction={null}
        personal={current.personal}
        actions={{
          onPersonalChange,
          onReferenceAction: references.onReferenceAction,
          async onSend(origin, _revision, message, ids) {
            const target = latestSessions.current.find(item => item.id === origin.conversationId)
            if (!target) return { status: "rejected", message: "示例会话不可用。" }
            setSent(count => count + 1)
            const entry: ConversationTimelineEntry = {
              kind: "message", id: `sent-${target.entries.length}`, role: "user", text: message,
            }
            const materials = ids.flatMap(id => {
              const snapshot = snapshotById.get(id)
              return snapshot ? [`${snapshot.title} · ${snapshot.version}\n${snapshot.text}`] : []
            })
            const entries = [...target.entries, entry]
            if (materials.length) entries.push({
              kind: "extension",
              id: `materials-${target.entries.length}`,
              content: <details className="hc219-preview-material"><summary>查看随消息发送的示例引用</summary>{materials.join("\n\n")}</details>,
            })
            install({ ...target, entries })
            return { status: "accepted" }
          },
        }}
        slots={{
          composer: <button type="button" className="wb-button wb-button-quiet wb-button-small" onClick={() => references.previewConversation(sourceConversationId)}>
            预览会话引用
          </button>,
        }}
      />
      {references.notice && <p className="hc219-preview-error" role="alert">{references.notice}</p>}
      {references.dialog}
      {directoryReply && <DirectoryPicker reply={path => {
        setDirectoryReply(null)
        directoryReply(path)
      }} />}
    </main>
  )
}

function DirectoryPicker({ reply }: { reply(path: string | null): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  return (
    <dialog
      ref={dialog}
      className="conversation-reference-dialog"
      aria-label="选择示例文件夹"
      onCancel={event => { event.preventDefault(); reply(null) }}
    >
      <h2>选择示例文件夹</h2>
      <button type="button" className="wb-button wb-button-secondary" onClick={() => reply("/示例/接口说明")}>
        /示例/接口说明（普通文件夹）
      </button>
      <div className="conversation-reference-footer">
        <button type="button" className="wb-button wb-button-quiet" onClick={() => reply(null)}>取消</button>
      </div>
    </dialog>
  )
}

createRoot(document.getElementById("root")!).render(<Preview />)
