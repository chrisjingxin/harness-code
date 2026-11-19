/**
 * 交互式回合回退选择题卡片：把 `/undo list` 文本列表转为可勾选轮次与范围的直观卡片。
 */
import { useEffect, useId, useMemo, useState } from "react"
import type { ReactElement } from "react"
import { IconHistory } from "@tabler/icons-react"
import { buildUndoCommand, type UndoChoiceItem, type UndoMode } from "./undo-choice.js"

const UNDO_MODES: ReadonlyArray<{ readonly id: UndoMode; readonly label: string }> = [
  { id: "both", label: "代码与对话" },
  { id: "code", label: "仅回退代码" },
  { id: "conversation", label: "仅回退对话" },
]

export type UndoChoiceCardProps = {
  readonly items: readonly UndoChoiceItem[]
  readonly stale: boolean
  readonly busy: boolean
  readonly disabledReason?: string
  readonly onExecuteUndo: (command: string) => Promise<{ readonly status: "accepted" | "rejected" | "unknown"; readonly message?: string }>
}

export function UndoChoiceCard({
  items,
  stale,
  busy,
  disabledReason,
  onExecuteUndo,
}: UndoChoiceCardProps): ReactElement {
  const groupName = useId()
  const orderedItems = useMemo(() => [...items].reverse(), [items])
  const [selectedTurn, setSelectedTurn] = useState<number>(() => orderedItems[0]?.turnNumber ?? items[0]!.turnNumber)
  const [mode, setMode] = useState<UndoMode>("both")
  const [submitting, setSubmitting] = useState(false)
  const [submittedCommand, setSubmittedCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!orderedItems.some(item => item.turnNumber === selectedTurn)) {
      const latest = orderedItems[0]?.turnNumber
      if (latest !== undefined) setSelectedTurn(latest)
    }
  }, [orderedItems, selectedTurn])

  const interactive = !stale && !busy && !disabledReason && !submitting && !submittedCommand
  const blockedHint = submittedCommand
    ? `已执行 ${submittedCommand}`
    : stale
      ? "后续已产生新对话，如需回退请重新发送 /undo list"
      : disabledReason || (busy ? "当前轮次运行中，请稍候" : undefined)

  const handleConfirm = async () => {
    if (!interactive) return
    const command = buildUndoCommand(selectedTurn, mode)
    setSubmitting(true)
    setError(null)
    try {
      const result = await onExecuteUndo(command)
      if (result.status === "accepted") {
        setSubmittedCommand(command)
      } else {
        setError(result.message || "回退请求未受理，请重试。")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送回退命令失败。")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="session-undo-card" aria-label="选择回退轮次">
      <header className="session-undo-head">
        <span className="session-undo-title">
          <IconHistory size={15} stroke={1.8} aria-hidden="true" />
          <span>选择要回退的轮次</span>
        </span>
        <span className="session-undo-count">共 {items.length} 轮</span>
      </header>
      <div className="session-undo-list" role="radiogroup" aria-label="可回退回合">
        {orderedItems.map(item => {
          const checked = selectedTurn === item.turnNumber
          return (
            <label
              key={item.turnNumber}
              className="session-undo-item"
              data-checked={checked || undefined}
            >
              <input
                type="radio"
                name={groupName}
                checked={checked}
                disabled={!interactive}
                onChange={() => setSelectedTurn(item.turnNumber)}
              />
              <span className="session-undo-turn-tag">#{item.turnNumber}</span>
              <span className="session-undo-summary">{item.summary}</span>
              {item.filesNote ? <span className="session-undo-files">{item.filesNote}</span> : null}
            </label>
          )
        })}
      </div>
      <footer className="session-undo-foot">
        <div className="session-undo-modes" role="radiogroup" aria-label="回退范围">
          {UNDO_MODES.map(opt => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={mode === opt.id}
              className={`session-undo-mode-btn${mode === opt.id ? " is-active" : ""}`}
              disabled={!interactive}
              onClick={() => setMode(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="session-undo-actions">
          {blockedHint ? <span className="session-undo-hint" role="status">{blockedHint}</span> : null}
          <button
            type="button"
            className="wb-button wb-button-primary wb-button-small"
            disabled={!interactive}
            onClick={() => { void handleConfirm() }}
          >
            {submitting ? "正在回退…" : "确认回退"}
          </button>
        </div>
      </footer>
      {error ? <p className="session-undo-error" role="alert">{error}</p> : null}
    </section>
  )
}
