/**
 * 团队知识阅读界面。装配方提供团队条目、正文、历史版本及引用动作。
 * 选择条目 → 读取正文 → 选择历史版本 → 预览固定材料。切换条目时丢弃旧读取结果。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Markdown } from "@workbench/ui"
import type { ConversationAvailability, ConversationReferenceView, RenderingActions } from "@workbench/ui"
import "./team-knowledge.css"

/** 团队与账号是显示和读取范围，由工作台提供。 */
export interface KnowledgeScope {
  readonly namespace: string
  readonly accountId: string
  readonly teamId: string
}

/** 列表只包含装配方提供的可读条目。 */
export interface KnowledgeItem {
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly versionLabel?: string
}

/** 版本标识及其显示信息均来自装配方。 */
export interface KnowledgeVersionSummary {
  readonly id: string
  readonly label: string
  readonly author: string
  readonly updatedAt: string
}

/**
 * 一次读取返回的固定版本。正文由 reference.snapshotText 承载，
 * 页面和预览读取同一份内容，reference.id 由装配方提供。
 */
export interface KnowledgeVersionContent {
  readonly itemId: string
  readonly versionId: string
  readonly versionLabel: string
  readonly author: string
  readonly updatedAt: string
  readonly reference: ConversationReferenceView
  readonly referenceAvailability: ConversationAvailability
}

/** 无权访问与读取错误由装配方反馈。 */
export type KnowledgeResult<T> =
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable" | "error"; readonly message: string }

export type KnowledgeList = KnowledgeResult<readonly KnowledgeItem[]> | { readonly status: "loading" }

/** 具名动作只表达用户意图，具体读取及本人会话动作由装配方完成。 */
export interface KnowledgeActions {
  readCurrent(scope: KnowledgeScope, itemId: string): Promise<KnowledgeResult<KnowledgeVersionContent>>
  readHistory?(scope: KnowledgeScope, itemId: string): Promise<KnowledgeResult<readonly KnowledgeVersionSummary[]>>
  readVersion?(scope: KnowledgeScope, itemId: string, versionId: string): Promise<KnowledgeResult<KnowledgeVersionContent>>
  onReference?(scope: KnowledgeScope, itemId: string, versionId: string, reference: ConversationReferenceView): void
  retryList?(): void
}

export interface TeamKnowledgeProps {
  readonly scope: KnowledgeScope
  readonly teamName: string
  readonly items: KnowledgeList
  readonly actions: KnowledgeActions
  readonly rendering?: RenderingActions
  readonly controls?: ReactNode
  readonly initialItemId?: string
  onEditItem?(itemId: string): void
}

type Resource<T> = KnowledgeResult<T> | { readonly status: "loading" }
type HistoryState = Resource<readonly KnowledgeVersionSummary[]> | { readonly status: "closed" }

async function read<T>(
  action: () => Promise<KnowledgeResult<T>>,
  message: string,
): Promise<KnowledgeResult<T>> {
  try {
    return await action()
  } catch {
    return { status: "error", message }
  }
}

/** 切换账号或团队时重建页面，旧请求的结果不会显示给新范围。 */
export function TeamKnowledge(props: TeamKnowledgeProps) {
  const { namespace, accountId, teamId } = props.scope
  return <KnowledgePage key={JSON.stringify([namespace, accountId, teamId])} {...props} />
}

function KnowledgePage({ scope, items, actions, rendering, controls, initialItemId, onEditItem }: TeamKnowledgeProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState<Resource<KnowledgeVersionContent> | null>(null)
  const [history, setHistory] = useState<HistoryState>({ status: "closed" })
  const [preview, setPreview] = useState(false)
  const contentRequest = useRef<symbol | null>(null)
  const historyRequest = useRef<symbol | null>(null)
  const selected = items.status === "ready" ? items.value.find(item => item.id === selectedId) : undefined

  useLayoutEffect(() => () => {
    contentRequest.current = null
    historyRequest.current = null
  }, [])
  useEffect(() => {
    if (initialItemId) selectItem(initialItemId)
  }, [initialItemId])

  async function loadContent(itemId: string, versionId?: string): Promise<void> {
    const request = Symbol()
    contentRequest.current = request
    setPreview(false)
    setContent({ status: "loading" })
    const result = versionId === undefined
      ? await read(() => actions.readCurrent(scope, itemId), "无法读取知识正文，请重试。")
      : actions.readVersion
        ? await read(() => actions.readVersion!(scope, itemId, versionId), "无法读取该版本，请重试。")
        : { status: "unavailable" as const, message: "历史版本暂不可用。" }
    if (contentRequest.current !== request) return
    if (result.status === "ready" && (result.value.itemId !== itemId ||
      (versionId !== undefined && result.value.versionId !== versionId))) {
      setContent({ status: "error", message: "返回的知识版本与所选条目不一致，请重试。" })
      return
    }
    if (result.status === "ready") {
      const { value } = result
      setContent({ status: "ready", value: { ...value, reference: { ...value.reference } } })
    } else {
      setContent(result)
    }
  }

  function selectItem(itemId: string): void {
    historyRequest.current = null
    setSelectedId(itemId)
    setHistory({ status: "closed" })
    void loadContent(itemId)
  }

  async function loadHistory(itemId: string): Promise<void> {
    if (!actions.readHistory || !actions.readVersion) return
    const request = Symbol()
    historyRequest.current = request
    setHistory({ status: "loading" })
    const result = await read(() => actions.readHistory!(scope, itemId), "无法读取版本历史，请重试。")
    if (historyRequest.current === request) setHistory(result)
  }

  const version = content?.status === "ready" ? content.value : null
  const reference = version?.reference
  const readable = Boolean(reference?.status === "ready")
  const historyAvailable = Boolean(actions.readHistory && actions.readVersion)
  return (
    <section className="team-knowledge-page" aria-label="团队知识">
      {controls ? <div className="view-bar">{controls}</div> : null}
      <div className="team-knowledge-layout">
        <nav className="team-knowledge-list" aria-label="知识条目">
          <h2>知识条目</h2>
          {items.status === "loading" && <p role="status">正在读取条目…</p>}
          {(items.status === "error" || items.status === "unavailable") && <p role="alert">{items.message}</p>}
          {items.status === "error" && actions.retryList && (
            <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={actions.retryList}>重试</button>
          )}
          {items.status === "ready" && (items.value.length ? (
            <ul>
              {items.value.map(item => (
                <li key={item.id}>
                  <button type="button" aria-current={selectedId === item.id ? "true" : undefined} onClick={() => selectItem(item.id)}>
                    {item.title}{item.category && <small> · {item.category}</small>}
                    {item.versionLabel && <small> · {item.versionLabel}</small>}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p>暂无知识条目。</p>)}
        </nav>
        <div className="team-knowledge-content">
          {items.status === "ready" && !selected && <p className="team-knowledge-empty">选择一个知识条目。</p>}
          {selected && <>
            <div className="team-knowledge-content-heading">
              <h2>{selected.title}</h2>
              <div className="team-knowledge-content-actions">
                {onEditItem && <button type="button" className="wb-button wb-button-quiet wb-button-small" onClick={() => onEditItem(selected.id)}>编辑条目</button>}
                <button type="button" className="wb-button wb-button-secondary wb-button-small"
                  disabled={!historyAvailable || history.status === "loading"}
                  title={historyAvailable ? undefined : "版本历史暂不可用"}
                  aria-expanded={history.status !== "closed"}
                  onClick={() => {
                    if (history.status === "ready") setHistory({ status: "closed" })
                    else void loadHistory(selected.id)
                  }}>
                  {history.status === "closed" ? "查看版本历史" : history.status === "loading" ? "正在读取历史…" : history.status === "ready" ? "收起版本历史" : "重试版本历史"}
                </button>
              </div>
            </div>
            {history.status === "loading" && <p className="team-knowledge-message" role="status">正在读取版本历史…</p>}
            {(history.status === "error" || history.status === "unavailable") &&
              <p className="team-knowledge-error" role="alert">{history.message}</p>}
            {history.status === "ready" && <div className="team-knowledge-history" aria-label="版本历史">
              <h3>版本历史</h3>
              {history.value.length ? <ul>
                {history.value.map(item => (
                  <li key={item.id}>
                    <button type="button" aria-pressed={version?.versionId === item.id} onClick={() => void loadContent(selected.id, item.id)}>
                      <strong>{item.label}</strong>
                      <span>{item.author} · {item.updatedAt}</span>
                    </button>
                  </li>
                ))}
              </ul> : <p className="team-knowledge-message">暂无历史版本。</p>}
            </div>}
            {content?.status === "loading" && <p className="team-knowledge-message" role="status">正在读取知识正文…</p>}
            {(content?.status === "error" || content?.status === "unavailable") && <>
              <p className="team-knowledge-error" role="alert">{content.message}</p>
              {content.status === "error" && (
                <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => void loadContent(selected.id)}>
                  重新读取当前版本
                </button>
              )}
            </>}
            {version && <>
              <VersionMetadata version={version} />
              {readable ? <>
                <div className="team-knowledge-markdown" aria-label="知识正文">
                  <Markdown text={version.reference.snapshotText} actions={rendering} />
                </div>
                <button type="button" className="wb-button wb-button-secondary team-knowledge-preview-button" onClick={() => setPreview(true)}>
                  预览固定版本
                </button>
              </> : <p className="team-knowledge-error" role="status">{reference?.message || "知识版本暂不可用。"}</p>}
            </>}
          </>}
        </div>
      </div>
      {preview && selected && version && readable && (
        <KnowledgePreview
          scope={scope}
          title={selected.title}
          version={version}
          rendering={rendering}
          onClose={() => setPreview(false)}
          onReference={actions.onReference ? (...args) => {
            setPreview(false)
            actions.onReference?.(...args)
          } : undefined}
        />
      )}
    </section>
  )
}

function VersionMetadata({ version }: { readonly version: KnowledgeVersionContent }) {
  return (
    <dl className="team-knowledge-metadata">
      <div><dt>版本</dt><dd>{version.versionLabel}</dd></div>
      <div><dt>作者</dt><dd>{version.author}</dd></div>
      <div><dt>更新时间</dt><dd>{version.updatedAt}</dd></div>
    </dl>
  )
}

function KnowledgePreview({ scope, title, version, rendering, onClose, onReference }: {
  readonly scope: KnowledgeScope
  readonly title: string
  readonly version: KnowledgeVersionContent
  readonly rendering?: RenderingActions
  onClose(): void
  onReference?: KnowledgeActions["onReference"]
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  const canReference = version.referenceAvailability.enabled && Boolean(onReference)
  const reason = version.referenceAvailability.reason ||
    (!onReference ? "会话引用暂不可用。" : !version.referenceAvailability.enabled ? "该版本暂不可引用。" : undefined)
  return (
    <dialog ref={dialog} className="team-knowledge-dialog" aria-labelledby={heading} onCancel={event => {
      event.preventDefault()
      onClose()
    }}>
      <h2 id={heading}>预览固定版本</h2>
      <h3>{title}</h3>
      <VersionMetadata version={version} />
      <p className="team-knowledge-reference-id">版本标识 <code>{version.versionId}</code></p>
      <div className="team-knowledge-preview-text" aria-label="固定版本正文">
        <Markdown text={version.reference.snapshotText} actions={rendering} />
      </div>
      {!canReference && reason && <p className="team-knowledge-message">{reason}</p>}
      <div className="team-knowledge-dialog-footer">
        <button type="button" className="wb-button wb-button-secondary" onClick={onClose}>关闭</button>
        <button type="button" className="wb-button wb-button-primary" disabled={!canReference} title={reason}
          onClick={() => onReference?.(scope, version.itemId, version.versionId, version.reference)}>
          引用到我的会话
        </button>
      </div>
    </dialog>
  )
}
