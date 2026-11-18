/** Workspace 知识的正式装配。列表和历史只读元数据，正文按用户选择的版本读取。 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { CollaborationResult, KnowledgeDetail, KnowledgeSummary, KnowledgeVersion } from "@workbench/contracts"
import type { RenderingActions } from "@workbench/ui"
import type { CollaborationAppsHost } from "../../../../collaboration-apps-host.js"
import { knowledgeReferenceId } from "../../../../collaboration-reference.js"
import type { ProjectNavigationScope } from "../../project-navigation/index.js"
import { readPages } from "../metadata.js"
import type { KnowledgeMetadataScope } from "../metadata.js"
import { knowledgeMaterial } from "../references/fixed-materials.js"
import { snapshotReferenceView } from "../references/conversation-references.js"
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
  previewFixed(id: string): void
  refreshMetadata(scope: ProjectNavigationScope): void
}

export function LiveTeamKnowledge({
  host, scope, teamName, revision, rendering, ownerName, canReference, previewFixed, refreshMetadata,
}: LiveTeamKnowledgeProps) {
  const { workspaceId, accountId, namespace } = scope
  const [queryInput, setQueryInput] = useState("")
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<KnowledgeList>({ status: "loading" })
  const [editing, setEditing] = useState<{ itemId?: string } | null>(null)
  const [updated, setUpdated] = useState<{ itemId?: string; revision: number }>()

  useEffect(() => {
    let current = true
    void readPages(afterId => host.listKnowledge(workspaceId, query, afterId), page => page.items, () => current)
      .then(result => {
        if (current) setItems({
          status: "ready", value: result.filter(item => !item.archived).map(item => ({
            id: item.knowledgeId, title: item.title, category: item.category, versionLabel: `v${item.version}`,
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
      versionLabel: material.version, author: material.owner, updatedAt: material.uploadedAt,
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

  return <>
    <TeamKnowledge
      key={updated?.revision ?? 0}
      scope={{ namespace, accountId, teamId: workspaceId }}
      teamName={teamName}
      items={items}
      initialItemId={updated?.itemId}
      rendering={rendering}
      onEditItem={itemId => setEditing({ itemId })}
      controls={<form className="team-knowledge-toolbar" onSubmit={event => {
        event.preventDefault()
        if (query !== queryInput.trim()) { setItems({ status: "loading" }); setQuery(queryInput.trim()) }
        else refreshMetadata(scope)
      }}>
        <input
          className="team-knowledge-search-input"
          aria-label="搜索团队知识"
          placeholder="搜索标题或关键词…"
          value={queryInput}
          onChange={event => setQueryInput(event.target.value)}
        />
        <button className="wb-button wb-button-secondary" type="submit">搜索</button>
        <button className="wb-button wb-button-primary" type="button" onClick={() => setEditing({})}>新建条目</button>
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
    {editing && <KnowledgeEditor host={host} workspaceId={workspaceId} itemId={editing.itemId}
      onClose={() => setEditing(null)} onSaved={detail => {
        setEditing(null)
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
  const [category, setCategory] = useState("")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [archiving, setArchiving] = useState(false)

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
    } catch {
      if (mounted.current) setError("无法读取知识条目，请重试。")
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => { void load() }, [workspaceId, itemId])

  const canEdit = !itemId || Boolean(loaded && !loaded.item.archived)
  const valid = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(termKey) && Boolean(category.trim() && title.trim() && text.trim())
  async function save() {
    if (!canEdit || submitting.current || (!archiving && !valid)) return
    submitting.current = true
    setBusy(true)
    setError("")
    try {
      const fields = { category: category.trim(), title: title.trim(), text }
      const result = loaded
        ? archiving
          ? await host.archiveKnowledge(workspaceId, loaded.item.knowledgeId, loaded.item.version)
          : await host.editKnowledge(workspaceId, loaded.item.knowledgeId, { ...fields, expectedVersion: loaded.item.version })
        : await host.createKnowledge(workspaceId, { ...fields, termKey })
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
        <label>术语键<input maxLength={64} readOnly={Boolean(itemId)} value={termKey}
          placeholder="billing-cycle" onChange={event => setTermKey(event.target.value)} /></label>
        <label>分类<input maxLength={80} value={category} onChange={event => setCategory(event.target.value)} /></label>
        <label>标题<input maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>正文<textarea rows={8} maxLength={16384} value={text} onChange={event => setText(event.target.value)} /></label>
      </fieldset>
    </form>}
    {loaded?.item.archived && <p role="status">该条目已归档。</p>}
    {error && <p role="alert" className="team-knowledge-error">{error}</p>}
    {error && !loaded && itemId && <button className="wb-button wb-button-secondary" disabled={busy} onClick={() => void load()}>重试读取</button>}
    <div className="team-knowledge-dialog-footer">
      <button className="wb-button wb-button-secondary" disabled={busy}
        onClick={() => { if (archiving) setArchiving(false); else onClose() }}>{archiving ? "返回编辑" : "取消"}</button>
      {loaded && canEdit && !archiving && <button className="wb-button wb-button-quiet" disabled={busy} onClick={() => setArchiving(true)}>归档</button>}
      <button className="wb-button wb-button-primary" disabled={busy || !canEdit || (!archiving && !valid)}
        onClick={() => void save()}>{archiving ? "确认归档" : "保存条目"}</button>
    </div>
  </dialog>
}
