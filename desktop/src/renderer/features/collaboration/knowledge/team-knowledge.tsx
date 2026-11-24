/**
 * 团队知识阅读界面。装配方提供团队条目、正文、历史版本及引用动作。
 * 选择条目 → 读取正文 → 选择历史版本 → 预览固定材料。切换条目时丢弃旧读取结果。
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Markdown } from "../../../../ui/index.js"
import type { ConversationAvailability, ConversationReferenceView, RenderingActions } from "../../../../ui/index.js"
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
  readonly detailLabel?: string
  readonly updatedAtLabel?: string
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
  readonly subtitle?: string
  readonly items: KnowledgeList
  readonly actions: KnowledgeActions
  readonly rendering?: RenderingActions
  readonly controls?: ReactNode
  readonly headerActions?: ReactNode
  readonly initialItemId?: string
  readonly selectedRequest?: { readonly itemId: string; readonly token: number }
  versionExtras?(version: KnowledgeVersionContent): ReactNode
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

function KnowledgePage({
  scope,
  teamName,
  subtitle,
  items,
  actions,
  rendering,
  controls,
  headerActions,
  initialItemId,
  selectedRequest,
  onEditItem,
  versionExtras,
}: TeamKnowledgeProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string>("")
  const [content, setContent] = useState<Resource<KnowledgeVersionContent> | null>(null)
  const [history, setHistory] = useState<HistoryState>({ status: "closed" })
  const [preview, setPreview] = useState(false)
  const contentRequest = useRef<symbol | null>(null)
  const historyRequest = useRef<symbol | null>(null)
  const listRef = useRef<HTMLElement>(null)

  const categories = useMemo(() => {
    if (items.status !== "ready") return [] as string[]
    const seen: string[] = []
    for (const item of items.value) {
      const cat = item.category?.trim()
      if (cat && !seen.includes(cat)) seen.push(cat)
    }
    return seen
  }, [items])

  const activeCategory = selectedCategory && categories.includes(selectedCategory) ? selectedCategory : ""
  const filteredItems = useMemo(() => {
    if (items.status !== "ready") return [] as readonly KnowledgeItem[]
    if (!activeCategory) return items.value
    return items.value.filter(item => item.category?.trim() === activeCategory)
  }, [items, activeCategory])

  const selected = items.status === "ready" ? items.value.find(item => item.id === selectedId) : undefined
  const requestedTargetId = selectedRequest?.itemId || initialItemId

  useLayoutEffect(() => () => {
    contentRequest.current = null
    historyRequest.current = null
  }, [])
  useEffect(() => {
    if (initialItemId) {
      setSelectedCategory("")
      selectItem(initialItemId)
    }
  }, [initialItemId])
  useEffect(() => {
    if (selectedRequest?.itemId) {
      setSelectedCategory("")
      selectItem(selectedRequest.itemId)
    }
  }, [selectedRequest?.itemId, selectedRequest?.token])
  useEffect(() => {
    if (items.status !== "ready") return
    const currentId = selectedIdRef.current
    if (currentId && filteredItems.some(item => item.id === currentId)) return
    if (requestedTargetId && items.value.some(item => item.id === requestedTargetId)) {
      if (activeCategory) setSelectedCategory("")
      if (currentId !== requestedTargetId) selectItem(requestedTargetId)
      return
    }
    const first = filteredItems[0]
    if (first) {
      selectItem(first.id)
    } else if (currentId !== null) {
      selectedIdRef.current = null
      contentRequest.current = null
      historyRequest.current = null
      setSelectedId(null)
      setContent(null)
      setHistory({ status: "closed" })
    }
  }, [items, filteredItems, selectedId, requestedTargetId, activeCategory])
  useEffect(() => {
    if (!selectedId || items.status !== "ready") return
    const activeButton = listRef.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
    activeButton?.scrollIntoView?.({ block: "nearest" })
  }, [selectedId, items.status])

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
    selectedIdRef.current = itemId
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
    <section className="team-knowledge-page page-wrap" aria-label="团队知识库">
      <header className="page-head team-knowledge-head">
        <div>
          <h1>团队知识库</h1>
          <p>{subtitle ?? `${teamName} · 团队共享规范、架构与约定，按固定版本引用到当前会话`}</p>
        </div>
        {headerActions && <div className="team-knowledge-head-actions">{headerActions}</div>}
      </header>

      {(controls || categories.length > 0) && (
        <div className="view-bar team-knowledge-bar">
          {controls}
          {categories.length > 0 && (
            <div className="team-knowledge-cats" role="group" aria-label="按分类筛选">
              <button
                type="button"
                className={`team-knowledge-cat-btn${activeCategory === "" ? " is-soft" : ""}`}
                aria-pressed={activeCategory === ""}
                onClick={() => setSelectedCategory("")}
              >
                全部
              </button>
              {categories.map(category => (
                <button
                  key={category}
                  type="button"
                  className={`team-knowledge-cat-btn${activeCategory === category ? " is-soft" : ""}`}
                  aria-pressed={activeCategory === category}
                  onClick={() => setSelectedCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          )}
          <span className="vb-spacer" />
          {items.status === "ready" && (
            <span className="team-knowledge-count">{filteredItems.length} 项条目</span>
          )}
        </div>
      )}

      {items.status !== "ready" ? (
        items.status === "loading" ? (
          <div className="panel team-knowledge-state-panel" role="status">
            <p className="team-knowledge-empty">正在读取团队知识条目…</p>
          </div>
        ) : (
          <div className="panel team-knowledge-state-panel" role="alert">
            <p className="team-knowledge-error">{items.message}</p>
            {items.status === "error" && actions.retryList && (
              <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={actions.retryList}>
                重试
              </button>
            )}
          </div>
        )
      ) : items.value.length === 0 ? (
        <div className="panel team-knowledge-state-panel" role="status">
          <p className="team-knowledge-empty">当前团队暂无知识条目。</p>
        </div>
      ) : (
        <div className="team-knowledge-layout review-layout">
          <nav className="team-knowledge-list k-side" ref={listRef} aria-label="知识条目">
            {filteredItems.length ? (
              <ul>
                {filteredItems.map(item => {
                  const isCurrent = selectedId === item.id
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`k-row${isCurrent ? " is-active" : ""}`}
                        aria-current={isCurrent ? "true" : undefined}
                        onClick={() => selectItem(item.id)}
                      >
                        <span className="kr-title">{item.title}</span>
                        <span className="kr-meta">
                          {item.category && (
                            <span className="hui-badge" data-tone="accent" data-size="xs">{item.category}</span>
                          )}
                          {item.versionLabel && (
                            <span className="hui-badge mono" data-tone="muted" data-size="xs">{item.versionLabel}</span>
                          )}
                          {item.updatedAtLabel && <span>{item.updatedAtLabel}</span>}
                          {item.detailLabel && <span>{item.detailLabel}</span>}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="team-knowledge-empty" role="status">当前分类下暂无知识条目。</p>
            )}
          </nav>

          <div className="team-knowledge-content k-doc">
            {!selected && <p className="team-knowledge-empty">从左侧选择一个知识条目以阅读正文。</p>}
            {selected && <>
              <div className="team-knowledge-doc-bar">
                {selected.category && (
                  <span className="hui-badge" data-tone="accent">{selected.category}</span>
                )}
                {(version?.versionLabel ?? selected.versionLabel) && (
                  <span className="hui-badge mono" data-tone="muted" data-size="xs">
                    {version?.versionLabel ?? selected.versionLabel}
                  </span>
                )}
                <span className="team-knowledge-doc-spacer" />
                <div className="team-knowledge-content-actions">
                  {actions.onReference && version && readable ? (
                    <button
                      type="button"
                      className="wb-button wb-button-primary wb-button-small"
                      disabled={!version.referenceAvailability.enabled}
                      title={version.referenceAvailability.reason ?? "将该版本固定内容引用到当前会话"}
                      onClick={() => actions.onReference?.(scope, version.itemId, version.versionId, version.reference)}
                    >
                      引用到当前会话
                    </button>
                  ) : null}
                  {onEditItem && (
                    <button type="button" className="wb-button wb-button-quiet wb-button-small" onClick={() => onEditItem(selected.id)}>
                      提出修订 / 管理
                    </button>
                  )}
                  <button
                    type="button"
                    className="wb-button wb-button-secondary wb-button-small"
                    disabled={!historyAvailable || history.status === "loading"}
                    title={historyAvailable ? undefined : "版本历史暂不可用"}
                    aria-expanded={history.status !== "closed"}
                    onClick={() => {
                      if (history.status === "ready") setHistory({ status: "closed" })
                      else void loadHistory(selected.id)
                    }}
                  >
                    {history.status === "closed" ? "版本历史" : history.status === "loading" ? "读取历史…" : history.status === "ready" ? "收起历史" : "重试历史"}
                  </button>
                </div>
              </div>
              <div className="team-knowledge-content-heading">
                <h2>{selected.title}</h2>
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
                {versionExtras?.(version)}
                {readable ? <>
                  <div className="team-knowledge-markdown" aria-label="知识正文">
                    <Markdown text={version.reference.snapshotText} actions={rendering} />
                  </div>
                  <div className="team-knowledge-doc-footer">
                    <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setPreview(true)}>
                      预览固定版本
                    </button>
                  </div>
                </> : <p className="team-knowledge-error" role="status">{reference?.message || "知识版本暂不可用。"}</p>}
              </>}
            </>}
          </div>
        </div>
      )}
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
