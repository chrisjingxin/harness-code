/** 两处现有区域共用的本机 MD 入口；仅预览/文本编辑，不管理条目或目录授权。 */
import { useEffect, useRef, useState } from "react"
import type { LocalExecutionScope, ProjectMemoryDocument, ProjectMemoryResult, WorkbenchContextHost } from "../../../shared/index.js"
import { Markdown } from "../../../ui/index.js"

type Ready = Extract<ProjectMemoryResult, { status: "ready" }>
type View = { key: string; saved?: Ready; draft: string; editing: boolean; busy: boolean; notice: string }
const blank = (key: string): View => ({ key, draft: "", editing: false, busy: false, notice: "" })

/** scope 必须来自当前用户的真实本人会话；所有异步结果以范围和请求代次再次隔离。 */
export function ProjectMemory({ scope, host }: { scope: LocalExecutionScope; host: WorkbenchContextHost }) {
  const [document, select] = useState<ProjectMemoryDocument>("team")
  const key = JSON.stringify([scope, document])
  const activeKey = useRef(key)
  activeKey.current = key
  const generation = useRef(0)
  const [state, setState] = useState<View>(() => blank(key))
  // render 阶段即隔离旧范围，不等 effect 才隐藏上一账号正文。
  const view = state.key === key ? state : blank(key)
  const dirty = view.editing && view.draft !== view.saved?.content
  function patch(change: Partial<View>) { setState(previous => previous.key === key ? { ...previous, ...change } : previous) }
  async function read(preserveDraft: boolean) {
    const version = ++generation.current
    const valid = () => generation.current === version && activeKey.current === key
    patch({ busy: true, notice: "" })
    try {
      const result = await host.readMemory(scope, document)
      if (!valid()) return
      if (!result.ok) { patch({ busy: false, notice: result.error.message }); return }
      const value = result.value
      if (value.status !== "ready") { patch({ busy: false, notice: "message" in value ? value.message : "文档暂不可读。" }); return }
      setState(previous => ({
        ...previous, key, saved: value, busy: false,
        draft: preserveDraft ? previous.draft : value.content,
        editing: preserveDraft && previous.editing,
        notice: preserveDraft ? "已读取最新内容，草稿已保留。请对照已保存正文合并后再保存。" : "",
      }))
    } catch { if (valid()) patch({ busy: false, notice: "记忆暂不可读，请重试。" }) }
  }
  useEffect(() => {
    setState(blank(key))
    if (scope.workspaceId !== null) void read(false)
    return () => { generation.current++ }
  }, [key, host])
  async function save() {
    if (!view.saved) return
    const version = ++generation.current
    const valid = () => generation.current === version && activeKey.current === key
    patch({ busy: true, notice: "" })
    try {
      const result = await host.updateMemory(scope, { document, content: view.draft, expectedRevision: view.saved.revision })
      if (!valid()) return
      if (!result.ok) { patch({ busy: false, notice: result.error.message }); return }
      const value = result.value
      if (value.status === "saved" || value.status === "no_change") {
        patch({ saved: { status: "ready", document, content: view.draft, revision: value.revision, size: value.size }, editing: false, busy: false, notice: value.message })
      } else patch({ busy: false, notice: "message" in value ? value.message : "保存结果未知，请重读核对。" })
    } catch { if (valid()) patch({ busy: false, notice: "保存结果未收到，草稿已保留。请重读核对实际文件后再保存。" }) }
  }
  if (scope.workspaceId === null) return <p role="status">此会话尚未绑定团队。</p>
  return <fieldset className="conversation-reference-targets project-memory" disabled={view.busy}>
    <legend>本机项目记忆</legend>
    <p>仅保存在本机，供当前账号和此会话所属团队使用。目录记录不授予文件访问权限。</p>
    <label>文档 <select value={document} disabled={dirty} onChange={event => select(event.target.value as ProjectMemoryDocument)}>
      <option value="team">团队工程记忆 · team.md</option>
      <option value="personal">个人工程记忆 · personal.md</option>
    </select></label>
    {view.saved && <>
      {view.editing && <label>Markdown 正文<textarea rows={12} value={view.draft} onChange={event => patch({ draft: event.target.value })} /></label>}
      <details open={!view.editing}><summary>已保存正文</summary><Markdown text={view.saved.content || "（空文档）"} /></details>
      {view.saved.size.overTarget && <p role="status">两份记忆合计超过 8 KiB，建议整理重复信息；仍可保存。</p>}
      {view.editing ? <>
        <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => { void save() }}>保存</button>
        <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => patch({ draft: view.saved!.content, editing: false, notice: "已取消编辑。" })}>取消编辑</button>
      </> : <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => patch({ editing: true, draft: view.saved!.content, notice: "" })}>编辑</button>}
    </>}
    <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => { void read(view.editing) }}>重新读取{view.editing ? "（保留草稿）" : ""}</button>
    {view.editing && <p>请先保存再切换账号、团队或离开页面；未保存内容不会写入。冲突时重新读取，草稿会保留。</p>}
    {view.busy && <p role="status">正在读取或保存…</p>}
    {view.notice && <p role="status">{view.notice}</p>}
  </fieldset>
}
