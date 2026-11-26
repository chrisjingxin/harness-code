import { KnowledgeDraftButton } from "../../knowledge-drafts/knowledge-draft-button.js"
import type { KnowledgeLevel, KnowledgeScope, KnowledgeProposalContent } from "@workbench/collaboration-client/types"
import { KnowledgeGovernance, KnowledgeProposalEditor, KnowledgeScopeFields, levelNames, blankProposal, publishedCandidate } from "./knowledge-governance.js"
import { KnowledgeFeedback } from "./knowledge-feedback.js"
/** Workspace 知识的正式装配。列表和历史只读元数据，正文按用户选择的版本读取。 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { CollaborationResult, KnowledgeDetail, KnowledgeSummary, KnowledgeVersion } from "@workbench/collaboration-client/types"
import { knowledgeReferenceId, type CollaborationAppsHost } from "../../../../shared/index.js"
import type { RenderingActions } from "../../../../ui/index.js"
import type { ProjectNavigationScope } from "../../project-navigation/index.js"
import { readPages } from "../metadata.js"
import type { KnowledgeMetadataScope } from "../metadata.js"
import { knowledgeMaterial } from "../references/fixed-materials.js"
import { snapshotReferenceView } from "../references/conversation-references.js"
import { formatRelativeTime } from "../../inbox/inbox-model.js"
import { resolveKnowledgeTermKey } from "./knowledge-key.js"
import { TeamKnowledge } from "./team-knowledge.js"
import type { KnowledgeList, KnowledgeResult, KnowledgeVersionContent } from "./team-knowledge.js"

export type KnowledgeRows =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: readonly KnowledgeSummary[] }

/** 工作区左栏数量、命令面板搜索与列表共用本轮摘要；仅在团队/账号/刷新修订变化时拉取未归档条目。 */
export function useWorkspaceKnowledgeMetadata(
  host: CollaborationAppsHost | undefined,
  scope: KnowledgeMetadataScope | null,
  revision: number,
): KnowledgeRows {
  const teamKey = scope ? JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId]) : ""
  const workspaceId = scope?.workspaceId
  const [state, setState] = useState<{ teamKey: string; rows: KnowledgeRows }>()
  useEffect(() => {
    if (!host || !teamKey || !workspaceId) return
    let active = true
    void readPages(afterId => host.listKnowledge(workspaceId, "", afterId), page => page.items, () => active)
      .then(items => {
        if (active) setState({ teamKey, rows: { status: "ready", items: items.filter(item => !item.archived) } })
      }).catch(error => {
        if (active) setState({ teamKey, rows: { status: "error", message: error instanceof Error ? error.message : "无法读取知识列表。" } })
      })
    return () => { active = false }
  }, [host, teamKey, workspaceId, revision])
  return teamKey && state?.teamKey === teamKey ? state.rows : { status: "loading" }
}

interface LiveTeamKnowledgeProps {
  readonly host: CollaborationAppsHost
  readonly scope: ProjectNavigationScope
  readonly teamName: string
  readonly revision: number
  readonly rendering: RenderingActions
  readonly ownerName: (id: string) => string
  readonly canReference: boolean
  readonly canManage: boolean
  readonly requestedItem?: { readonly itemId: string; readonly token: number } | null
  previewFixed(id: string): void
  refreshMetadata(scope: ProjectNavigationScope): void
}

export function LiveTeamKnowledge({
  host, scope, teamName, revision, rendering, ownerName, canReference, canManage, requestedItem, previewFixed, refreshMetadata,
}: LiveTeamKnowledgeProps) {
  const { workspaceId, accountId, namespace } = scope
  const [view,setView]=useState<"published"|"mine"|"review"|"recheck">("published")
  const [proposalInitial,setProposalInitial]=useState<KnowledgeProposalContent|null>(null)
  useEffect(()=>{if(!canManage&&(view==="review"||view==="recheck"))setView("published")},[canManage,view])
  const [queryInput, setQueryInput] = useState("")
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<KnowledgeList>({ status: "loading" })
  const [editing, setEditing] = useState<{ itemId?: string } | null>(null)
  const [updated, setUpdated] = useState<{ itemId?: string; revision: number }>()
  const [targetRequest, setTargetRequest] = useState<{ readonly itemId: string; readonly token: number } | undefined>(
    requestedItem ?? undefined,
  )
  useEffect(() => { if (!canManage) setEditing(null) }, [canManage])
  const lastHandledToken = useRef(requestedItem?.token ?? 0)

  useEffect(() => {
    if (!requestedItem || requestedItem.token === lastHandledToken.current) return
    lastHandledToken.current = requestedItem.token
    if (query) {
      setItems({ status: "loading" })
      setQuery("")
    }
    setQueryInput("")
    setTargetRequest(requestedItem)
  }, [requestedItem, query])

  useEffect(() => {
    let current = true
    void readPages(afterId => host.listKnowledge(workspaceId, query, afterId), page => page.items, () => current)
      .then(result => {
        if (current) setItems({
          status: "ready", value: result.filter(item => !item.archived).map(item => ({
            id: item.knowledgeId,
            title: item.title,
            category: item.category,
            versionLabel: `v${item.version}`,
            detailLabel: `${levelNames[item.level]} · ${item.scope.kind === "workspace" ? "全团队" : `${item.scope.repositoryIds.length}个仓库`} · Agent工具读取${item.health.readCount}次${item.health.needsReview ? " · 待复核" : ""}`,
            updatedAtLabel: formatRelativeTime(item.updatedAtMs),
          })),
        })
      }).catch(error => {
        if (current) setItems({ status: "error", message: error instanceof Error ? error.message : "无法读取知识列表。" })
      })
    return () => { current = false }
  }, [host, workspaceId, query, revision])

  function projectVersion(value: KnowledgeVersion): KnowledgeVersionContent {
    const material = knowledgeMaterial(value, ownerName)
    return {
      itemId: value.knowledgeId, versionId: value.version.versionId,
      versionLabel: material.version, author: `${material.owner}（贡献：${value.version.contributors.map(ownerName).join("、")}；审核：${value.version.reviewerId?ownerName(value.version.reviewerId):"历史未知"}）`, updatedAt: material.uploadedAt,
      reference: snapshotReferenceView(material),
      referenceAvailability: value.archived
        ? { enabled: false, reason: "该条目已归档。" }
        : { enabled: canReference, reason: canReference ? undefined : "请先登记本机设备。" },
    }
  }
  function projectError(result: Extract<CollaborationResult<unknown>, { ok: false }>): KnowledgeResult<never> {
    return {
      status: result.error.code === "RESOURCE_NOT_FOUND" ? "unavailable" : "error",
      message: result.error.message,
    }
  }

  const tabs = (
    <nav className="seg knowledge-view-tabs" aria-label="知识管理">
      <button type="button" aria-pressed={view === "published"} onClick={() => setView("published")}>已发布</button>
      <button type="button" aria-pressed={view === "mine"} onClick={() => setView("mine")}>我的提议</button>
      {canManage && (
        <>
          <button type="button" aria-pressed={view === "review"} onClick={() => setView("review")}>待审核</button>
          <button type="button" aria-pressed={view === "recheck"} onClick={() => setView("recheck")}>待复核</button>
        </>
      )}
    </nav>
  )
  if (view !== "published") return (
    <section className="page-shell" aria-label="知识管理">
      {tabs}
      <KnowledgeGovernance
        key={JSON.stringify([namespace, accountId, workspaceId, view, canManage])}
        host={host}
        workspaceId={workspaceId}
        accountId={accountId}
        admin={canManage}
        view={view}
        onChanged={() => refreshMetadata(scope)}
      />
    </section>
  )
  return <>
    <TeamKnowledge
      key={updated?.revision ?? 0}
      tabs={tabs}
      scope={{ namespace, accountId, teamId: workspaceId }}
      teamName={teamName}
      items={items}
      initialItemId={updated?.itemId}
      selectedRequest={targetRequest}
      rendering={rendering}
      onEditItem={itemId => {
        if (canManage) setEditing({ itemId })
        else void host.readKnowledge(workspaceId, itemId).then(r => {
          if (r.ok) setProposalInitial({ ...blankProposal(), intent: "supplement", targetKnowledgeId: r.value.item.knowledgeId, baseVersionId: r.value.item.currentVersionId, baseItemVersion: r.value.item.version, candidate: publishedCandidate(r.value) })
        })
      }}
      versionExtras={v => <KnowledgeFeedback key={JSON.stringify([accountId, workspaceId, v.itemId, v.versionId])} host={host} workspaceId={workspaceId} knowledgeId={v.itemId} versionId={v.versionId} />}
      headerActions={canManage ? (
        <>
          <KnowledgeDraftButton key={JSON.stringify([namespace, accountId, workspaceId])} workspaceId={workspaceId} accountId={accountId} maintenance />
          <button className="wb-button wb-button-primary wb-button-small" type="button" onClick={() => setEditing({})}>
            新建知识条目
          </button>
        </>
      ) : (
        <button className="wb-button wb-button-primary wb-button-small" type="button" onClick={() => setProposalInitial(blankProposal())}>
          提出新知识
        </button>
      )}
      controls={<form className="team-knowledge-toolbar" onSubmit={event => {
        event.preventDefault()
        const trimmed = queryInput.trim()
        if (query !== trimmed) { setItems({ status: "loading" }); setQuery(trimmed) }
        else refreshMetadata(scope)
      }}>
        <input
          className="team-knowledge-search-input"
          aria-label="搜索团队知识"
          placeholder="搜索标题或关键词…"
          value={queryInput}
          onChange={event => setQueryInput(event.target.value)}
        />
        <button className="wb-button wb-button-secondary wb-button-small" type="submit">搜索</button>
        {query && (
          <button
            className="wb-button wb-button-quiet wb-button-small"
            type="button"
            onClick={() => {
              setQueryInput("")
              setItems({ status: "loading" })
              setQuery("")
            }}
          >
            清空
          </button>
        )}
      </form>}
      actions={{
        async readCurrent(_source, itemId) {
          const result = await host.readKnowledge(workspaceId, itemId)
          return result.ok ? { status: "ready", value: projectVersion(result.value.current) } : projectError(result)
        },
        async readHistory(_source, itemId) {
          const versions = await readPages(afterId => host.listKnowledgeVersions(workspaceId, itemId, afterId), page => page.versions)
          return { status: "ready", value: versions.map(version => ({
            id: version.versionId, label: `v${version.version}`, author: ownerName(version.authorId),
            updatedAt: new Date(version.createdAtMs).toLocaleString(),
          })) }
        },
        async readVersion(_source, itemId, versionId) {
          const result = await host.readKnowledgeVersion(workspaceId, itemId, versionId)
          return result.ok ? { status: "ready", value: projectVersion(result.value) } : projectError(result)
        },
        onReference: canReference ? (_source, knowledgeId, versionId) => previewFixed(knowledgeReferenceId({ knowledgeId, versionId })) : undefined,
        retryList: () => refreshMetadata(scope),
      }}
    />
    {proposalInitial&&<KnowledgeProposalEditor key={JSON.stringify([namespace,accountId,workspaceId])} host={host} workspaceId={workspaceId} accountId={accountId} admin={canManage} initial={proposalInitial} onClose={()=>setProposalInitial(null)} onSaved={()=>refreshMetadata(scope)}/>}
    {editing && canManage && <KnowledgeEditor host={host} workspaceId={workspaceId} itemId={editing.itemId}
      onClose={() => setEditing(null)} onSaved={detail => {
        setEditing(null)
        setTargetRequest(undefined)
        if (query) setQuery("")
        setQueryInput("")
        setUpdated(previous => ({
          itemId: detail.item.archived ? undefined : detail.item.knowledgeId,
          revision: (previous?.revision ?? 0) + 1,
        }))
        refreshMetadata(scope)
      }} />}
  </>
}

const KNOWLEDGE_CATEGORY_PRESETS = ["规范", "架构", "约定", "术语"] as const

function KnowledgeEditor({ host, workspaceId, itemId, onClose, onSaved }: {
  host: CollaborationAppsHost; workspaceId: string; itemId?: string; onClose(): void; onSaved(detail: KnowledgeDetail): void
}) {
  const heading = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState<KnowledgeDetail | null>(null)
  const [termKey, setTermKey] = useState("")
  const [category, setCategory] = useState(itemId ? "" : "规范")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [archiving, setArchiving] = useState(false)
  const [level,setLevel]=useState<KnowledgeLevel>("experience")
  const [knowledgeScope,setKnowledgeScope]=useState<KnowledgeScope>({kind:"workspace",repositoryIds:[]})
  const request=useRef({key:"",id:""})

  useLayoutEffect(() => {
    mounted.current = true
    const element = dialog.current
    element?.showModal()
    return () => { mounted.current = false; element?.close() }
  }, [])

  async function load() {
    if (!itemId || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      const result = await host.readKnowledge(workspaceId, itemId)
      if (!mounted.current) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.item.knowledgeId !== itemId) { setError("读取的知识条目不匹配。"); return }
      const detail = result.value
      setLoaded(detail)
      setTermKey(detail.item.termKey)
      setCategory(detail.item.category)
      setTitle(detail.item.title)
      setText(detail.current.text)
      setLevel(detail.item.level)
      setKnowledgeScope(detail.item.scope)
    } catch {
      if (mounted.current) setError("无法读取知识条目，请重试。")
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => { void load() }, [workspaceId, itemId])

  const canEdit = !itemId || Boolean(loaded && !loaded.item.archived)
  const resolvedKey = itemId
    ? { termKey, autoGenerated: false, valid: Boolean(termKey) }
    : resolveKnowledgeTermKey(title, termKey)
  const missingReason = !title.trim()
    ? "请先填写标题"
    : !category.trim()
      ? "请填写或选择一个分类"
      : !text.trim()
        ? "请填写知识正文"
        : !resolvedKey.valid
          ? (resolvedKey.error ?? "标识键格式有误")
          : ""
  const valid = !missingReason

  async function save() {
    if (!canEdit || submitting.current || (!archiving && !valid)) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      const key=JSON.stringify([itemId,category,title,text,level,knowledgeScope,loaded?.item.version]);if(request.current.key!==key)request.current={key,id:crypto.randomUUID()}
      const fields = { category: category.trim(), title: title.trim(), text, level, scope:knowledgeScope,contentType:"article" as const,requestId:request.current.id }
      const result = loaded
        ? archiving
          ? await host.archiveKnowledge(workspaceId, loaded.item.knowledgeId, loaded.item.version, request.current.id)
          : await host.editKnowledge(workspaceId, loaded.item.knowledgeId, { ...fields, expectedVersion: loaded.item.version })
        : await host.createKnowledge(workspaceId, { ...fields, termKey: resolvedKey.termKey })
      if (!mounted.current) return
      if (result.ok) onSaved(result.value)
      else setError(result.error.message)
    } catch {
      if (mounted.current) setError("无法确认保存结果，请重试。")
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <dialog className="team-knowledge-dialog" ref={dialog} aria-labelledby={heading} onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>
    <h2 id={heading}>{archiving ? "归档知识条目" : itemId ? "编辑知识条目" : "新建知识条目"}</h2>
    {archiving ? <p>归档后条目退出列表，已有引用仍指向原版本。</p> : <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="project-task-fields" disabled={busy || !canEdit}>
        <label>
          标题
          <input
            autoFocus={!itemId}
            maxLength={200}
            value={title}
            placeholder="例如：除法安全规范"
            onChange={event => setTitle(event.target.value)}
          />
        </label>
        <label>级别<select value={level} onChange={e=>setLevel(e.target.value as KnowledgeLevel)}>{Object.entries(levelNames).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <KnowledgeScopeFields workspaceId={workspaceId} scope={knowledgeScope} onChange={setKnowledgeScope} disabled={busy}/>
        <div className="team-knowledge-category-field">
          <label>
            分类
            <input
              maxLength={80}
              value={category}
              placeholder="规范 / 架构 / 约定 / 术语"
              onChange={event => setCategory(event.target.value)}
            />
          </label>
          <div className="team-knowledge-presets" role="group" aria-label="常用分类">
            {KNOWLEDGE_CATEGORY_PRESETS.map(preset => (
              <button
                key={preset}
                type="button"
                className={`team-knowledge-preset${category.trim() === preset ? " is-active" : ""}`}
                onClick={() => setCategory(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
        <label>
          正文
          <textarea
            rows={7}
            maxLength={16384}
            value={text}
            placeholder="填写团队约定的规范、背景或可操作细则（支持 Markdown）…"
            onChange={event => setText(event.target.value)}
          />
        </label>
        <label className="team-knowledge-key-field">
          <span>{itemId ? "标识键" : "标识键（可选）"}</span>
          <input
            maxLength={64}
            readOnly={Boolean(itemId)}
            value={termKey}
            aria-invalid={Boolean(!itemId && termKey.trim() && !resolvedKey.valid)}
            placeholder={
              itemId
                ? ""
                : resolvedKey.autoGenerated && resolvedKey.termKey
                  ? `留空自动生成：${resolvedKey.termKey}`
                  : "留空将根据标题自动生成（仅支持小写英文、数字、. _ -）"
            }
            onChange={event => setTermKey(event.target.value)}
          />
          {!itemId && resolvedKey.error ? (
            <span className="team-knowledge-field-error" role="status">{resolvedKey.error}</span>
          ) : !itemId ? (
            <span className="team-knowledge-field-hint">用于引用链接的英文短标识，直接留空即可自动生成。</span>
          ) : null}
        </label>
      </fieldset>
    </form>}
    {loaded?.item.archived && <p role="status">该条目已归档。</p>}
    {error && <p role="alert" className="team-knowledge-error">{error}</p>}
    {error && !loaded && itemId && <button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void load()}>重试读取</button>}
    <div className="team-knowledge-dialog-footer">
      {!archiving && canEdit && missingReason ? (
        <span className="team-knowledge-footer-hint">{missingReason}</span>
      ) : null}
      <button className="wb-button wb-button-secondary" disabled={busy}
        onClick={() => { if (archiving) setArchiving(false); else onClose() }}>{archiving ? "返回编辑" : "取消"}</button>
      {loaded && canEdit && !archiving && <button className="wb-button wb-button-quiet" disabled={busy} onClick={() => setArchiving(true)}>归档</button>}
      <button className="wb-button wb-button-primary" disabled={busy || !canEdit || (!archiving && !valid)}
        title={!archiving && missingReason ? missingReason : undefined}
        onClick={() => void save()}>{archiving ? "确认归档" : "保存条目"}</button>
    </div>
  </dialog>
}
