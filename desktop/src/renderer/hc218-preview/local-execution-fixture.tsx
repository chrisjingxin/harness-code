/**
 * HC-218 的独立 Electron 文本执行夹具。用固定的桌面显示更新验证公共对话组件，
 * 所有状态只保存在预览内存中，不存在 Agent、线上会话和实际目录。
 */
import { useEffect, useReducer, useRef, useState } from "react"
import { ConversationView } from "../../ui/index.js"
import type { ConversationScope } from "../../ui/index.js"
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
      <div
        className="view-bar"
        style={{ padding: "12px var(--pad-stage, 24px) 0", maxWidth: 788, width: "100%", margin: "0 auto" }}
      >
        <span className="meta">
          模拟显示事件，发送后依次出现思考、工具组与回答，约 25 秒后结束；输入「拒绝测试」可验证保留草稿。
        </span>
        <span className="vb-spacer" />
        <label className="od-row" style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>
          <input type="checkbox" checked={available} onChange={event => setAvailable(event.currentTarget.checked)} />
          模拟宿主可用
        </label>
      </div>
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
              const push = (delay: number, update: Parameters<typeof updateExecution>[0]) =>
                window.setTimeout(() => updateExecution(update), delay)
              pending.current = [
                push(300, { kind: "thought", turnId, text: "先检索相关文件，再决定改动范围……" }),
                push(500, { kind: "tool", turnId, tool: { id: "fixture-search", title: "检索上下文", kind: "search", status: "in_progress", input: '{\n  "query": "同步状态推导"\n}' } }),
                push(900, { kind: "tool", turnId, tool: { id: "fixture-search", status: "completed", output: "找到 3 个匹配：session-model.ts、local-execution-view.ts、timeline-model.ts" } }),
                push(1100, { kind: "tool", turnId, tool: { id: "fixture-edit", title: "修改状态推导", kind: "edit", status: "in_progress" } }),
                push(1300, {
                  kind: "tool", turnId,
                  tool: { id: "fixture-edit", diffs: [{ path: "src/session-model.ts", oldText: '  return "idle"', newText: '  return "syncing"' }] },
                }),
                push(1500, { kind: "tool", turnId, tool: { id: "fixture-cache", title: "刷新缓存", status: "in_progress" } }),
                push(1600, { kind: "thought", turnId, text: "差异已写入，等待修改收尾。" }),
                push(1800, { kind: "tool", turnId, tool: { id: "fixture-cache", status: "completed" } }),
                push(1900, { kind: "assistant-text", turnId, text: "这是第一段回复。" }),
                push(2200, { kind: "assistant-text", turnId, text: "这是第二段回复。" }),
                window.setTimeout(() => {
                  updateExecution({ kind: "finished", turnId })
                  pending.current = []
                }, 25_000),
              ]
              return { status: "accepted" }
            },
          }}
        />
      </div>
    </section>
  )
}
