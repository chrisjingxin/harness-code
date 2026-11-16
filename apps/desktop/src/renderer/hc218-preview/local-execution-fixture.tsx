/**
 * HC-218 的独立 Electron 文本执行夹具。用固定的桌面显示更新验证公共对话组件，
 * 所有状态只保存在预览内存中，不存在 Agent、线上会话和实际目录。
 */
import { useEffect, useReducer, useRef, useState } from "react"
import { ConversationView } from "@workbench/ui"
import type { ConversationScope } from "@workbench/ui"
import { applyLocalExecutionUpdate, emptyLocalExecutionView, projectLocalExecution } from "../features/session/local-execution-view.js"
import { applyConversationPersonalChange, EMPTY_PERSONAL_STATE } from "../features/session/session-provider.js"

export const localExecutionFixtureTitle = "本机执行界面夹具"

export function LocalExecutionFixture({ scope }: { readonly scope: ConversationScope }) {
  const [personal, updatePersonal] = useReducer(applyConversationPersonalChange, EMPTY_PERSONAL_STATE)
  const [execution, updateExecution] = useReducer(applyLocalExecutionUpdate, emptyLocalExecutionView)
  const [available, setAvailable] = useState(true)
  const pending = useRef<number[]>([])
  useEffect(() => () => {
    pending.current.forEach(timer => window.clearTimeout(timer))
  }, [])

  const view = projectLocalExecution({
    entries: [],
    contentRevision: 0,
    composer: {
      send: { enabled: available, reason: available ? undefined : "夹具：本机宿主不可用" },
      cancel: { enabled: false },
      primaryActions: "send",
      statusText: available ? undefined : "夹具：本机宿主不可用",
      commands: [],
      controls: [],
      projectTarget: null,
      references: [],
      attachments: [],
    },
  }, execution)

  return (
    <section className="session-center" aria-label={localExecutionFixtureTitle}>
      <header className="session-heading">
        <div>
          <h1>{localExecutionFixtureTitle}</h1>
          <p className="session-subtitle">模拟显示事件。输入「拒绝测试」可验证拒绝后保留草稿。</p>
        </div>
        <label>
          <input type="checkbox" checked={available} onChange={event => setAvailable(event.currentTarget.checked)} />
          模拟宿主可用
        </label>
      </header>
      <div className="session-conversation-wrap">
        <ConversationView
          {...view}
          scope={scope}
          visible
          interaction={null}
          personal={personal}
          actions={{
            onPersonalChange: (_scope, change) => updatePersonal(change),
            onSend: async (_scope, _revision, text) => {
              if (text.trim() === "拒绝测试") return { status: "rejected", message: "夹具：发送未被受理，草稿已保留" }
              const turnId = crypto.randomUUID()
              updateExecution({ kind: "accepted", turnId, text, author: { id: scope.accountId, displayName: "预览用户" } })
              pending.current = [
                window.setTimeout(() => updateExecution({ kind: "assistant-text", turnId, text: "这是第一段回复。" }), 300),
                window.setTimeout(() => updateExecution({ kind: "assistant-text", turnId, text: "这是第二段回复。" }), 900),
                window.setTimeout(() => {
                  updateExecution({ kind: "finished", turnId })
                  pending.current = []
                }, 1500),
              ]
              return { status: "accepted" }
            },
          }}
        />
      </div>
    </section>
  )
}
