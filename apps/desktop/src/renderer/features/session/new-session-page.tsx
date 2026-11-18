/**
 * 新会话准备页（"今天想推进什么？"）。
 *
 * 【功能定义】
 * 让用户在当前 Project 下自选任意本机工作目录（支持普通非 Git 文件夹）、输入待发起的讨论草稿，
 * 并诚实展示当前设备登记与 Agent 可用性；选择目录和输入草稿仅保存在本人本机范围，不自动建会。
 */
import { useRef } from "react"
import type { FormEvent, KeyboardEvent, ReactElement } from "react"
import { IconArrowUp, IconChevronDown, IconFolder, IconLoader2 } from "@tabler/icons-react"
import type { LocalExecutionProviderInfo } from "../../../local-execution-host.js"
import { directoryBasename } from "./session-model.js"
import type { NewSessionDraft } from "./contracts.js"

export type NewSessionPageProps = {
  readonly projectName: string
  readonly draft: NewSessionDraft
  readonly busy: boolean
  readonly canCreateConversation: boolean
  readonly createBlockedReason?: string
  readonly agentLabel: string
  readonly agentAvailable: boolean
  readonly providers?: readonly LocalExecutionProviderInfo[]
  readonly selectedProviderId?: string
  readonly errorMessage?: string | null
  readonly onChooseDirectory: () => void
  readonly onSelectProvider?: (providerId: string) => void
  readonly onDraftChange: (text: string) => void
  readonly onStartSession: () => void
}

export function NewSessionPage({
  projectName,
  draft,
  busy,
  canCreateConversation,
  createBlockedReason,
  agentLabel,
  agentAvailable,
  providers,
  selectedProviderId,
  errorMessage,
  onChooseDirectory,
  onSelectProvider,
  onDraftChange,
  onStartSession,
}: NewSessionPageProps): ReactElement {
  const composing = useRef(false)
  const folderName = directoryBasename(draft.directoryPath)
  const hasPrompt = draft.draftText.trim().length > 0
  const canSubmit = Boolean(draft.directoryPath && hasPrompt && canCreateConversation && !busy)
  const disabledReason = !draft.directoryPath
    ? "请先选择一个本机工作目录"
    : !hasPrompt
      ? "请输入你想讨论或推进的事项"
      : !canCreateConversation
        ? createBlockedReason ?? "当前尚不能发起新会话"
        : undefined

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (canSubmit) onStartSession()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (canSubmit) onStartSession()
    }
  }

  return (
    <section className="session-new-page" aria-label="新会话准备">
      <h1>今天想推进什么？</h1>
      <p>在“{projectName}”中创建自己的会话。</p>
      <form className="session-new-card" onSubmit={handleSubmit}>
        <textarea
          value={draft.draftText}
          onChange={event => onDraftChange(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={handleKeyDown}
          placeholder="描述你想讨论或推进的事项…"
          aria-label="新会话初始内容"
        />
        <div className="session-new-card-footer">
          <div className="session-new-card-left">
            <button
              type="button"
              className="session-new-chip"
              onClick={onChooseDirectory}
              title={draft.directoryPath ?? "选择一个本机文件夹（支持普通非 Git 目录）"}
            >
              <IconFolder size={13} aria-hidden="true" />
              <span>{folderName || "选择文件夹"}</span>
              <IconChevronDown size={12} aria-hidden="true" />
            </button>
            {providers && providers.length > 0 && onSelectProvider ? (
              <select
                className="session-new-provider-select"
                aria-label="选择本机 Agent"
                value={selectedProviderId ?? providers[0]?.id ?? ""}
                disabled={busy}
                onChange={event => onSelectProvider(event.currentTarget.value)}
              >
                {providers.map(provider => (
                  <option key={provider.id} value={provider.id}>
                    {provider.available ? provider.label : `${provider.label}（暂不可用）`}
                  </option>
                ))}
              </select>
            ) : null}
            <span
              className="session-tag"
              data-tone={agentAvailable ? "success" : "warning"}
              title={agentLabel}
            >
              {agentAvailable ? "本机可用" : agentLabel}
            </span>
          </div>
          <div className="session-new-card-right">
            <button
              type="submit"
              className="session-new-send-btn"
              aria-label={busy ? "创建中…" : "开始会话"}
              disabled={!canSubmit}
              title={disabledReason ?? (busy ? "创建中…" : "开始会话")}
            >
              {busy
                ? <IconLoader2 size={14} aria-hidden="true" className="session-plan-spin" />
                : <IconArrowUp size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </form>
      {(errorMessage || (!canCreateConversation && createBlockedReason)) ? (
        <div className="session-new-send">
          <span
            className="session-new-status"
            data-tone={errorMessage ? "danger" : undefined}
            role={errorMessage ? "alert" : "status"}
          >
            {errorMessage || createBlockedReason}
          </span>
        </div>
      ) : null}
      <p className="session-new-note">目录由你选择，支持普通非 Git 文件夹。</p>
    </section>
  )
}
