/**
 * 新会话准备页（"今天想推进什么？"）。
 *
 * 【功能定义】
 * 让用户在当前 Project 下自选任意本机工作目录（支持普通非 Git 文件夹）、输入待发起的讨论草稿，
 * 并诚实展示当前设备登记与 Agent 可用性；选择目录和输入草稿仅保存在本人本机范围，不自动建会。
 */
import type { ReactElement } from "react"
import { ArrowRightIcon, ChevronDownIcon, FolderIcon } from "./icons.js"
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
  readonly errorMessage?: string | null
  readonly onChooseDirectory: () => void
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
  errorMessage,
  onChooseDirectory,
  onDraftChange,
  onStartSession,
}: NewSessionPageProps): ReactElement {
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

  return (
    <section className="session-new-page" aria-label="新会话准备">
      <h1>今天想推进什么？</h1>
      <p>在“{projectName}”中创建自己的会话。</p>
      <div className="session-new-controls">
        <button
          type="button"
          className="wb-button wb-button-secondary wb-button-small"
          onClick={onChooseDirectory}
          title={draft.directoryPath ?? "选择一个本机文件夹（支持普通非 Git 目录）"}
        >
          <FolderIcon size={14} />
          <span>{folderName || "选择文件夹"}</span>
          <ChevronDownIcon size={12} />
        </button>
        <span
          className="session-tag"
          data-tone={agentAvailable ? "success" : "warning"}
          title={agentAvailable ? "本机 Agent 可用" : "当前仅可准备目录与草稿，待 Agent 接入后可发起执行"}
        >
          {agentLabel}
        </span>
      </div>
      <textarea
        value={draft.draftText}
        onChange={event => onDraftChange(event.currentTarget.value)}
        placeholder="描述你想讨论或完成的事情…"
        aria-label="新会话初始内容"
      />
      <div className="session-new-send">
        <span
          className="session-new-status"
          data-tone={errorMessage ? "danger" : undefined}
          role={errorMessage ? "alert" : "status"}
        >
          {errorMessage || (!canCreateConversation ? createBlockedReason : "")}
        </span>
        <button
          type="button"
          className="wb-button wb-button-primary"
          disabled={!canSubmit}
          title={disabledReason}
          onClick={onStartSession}
        >
          <ArrowRightIcon size={14} />
          <span>{busy ? "正在创建…" : "开始会话"}</span>
        </button>
      </div>
      <p className="session-new-note">目录由你选择，可以是普通文件夹。</p>
    </section>
  )
}
