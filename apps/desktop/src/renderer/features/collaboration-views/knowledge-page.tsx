/**
 * 团队知识库双栏页（1:1 还原原型稿 viewKnowledge）：
 * 支持 Workspace 公共规约与本项目沉淀切换、新建知识、内联编辑并升级版本号、@ 引用到本机会话。
 */
import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import type { NavigationMember } from "@workbench/ui"
import { AtSignIcon, PlusIcon } from "./collab-icons.js"
import { UserAvatar } from "./collab-overlays.js"
import type { CollabKnowledge } from "./collab-store.js"

export function TeamKnowledgePage({
  workspaceName,
  projectName,
  members,
  knowledge,
  selectedId,
  onSelect,
  onCreateClick,
  onSaveEdit,
  onCiteToSession,
}: {
  readonly workspaceName: string
  readonly projectName: string
  readonly members: readonly NavigationMember[]
  readonly knowledge: readonly CollabKnowledge[]
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onCreateClick: () => void
  readonly onSaveEdit: (id: string, sum: string, body: string) => void
  readonly onCiteToSession: (item: CollabKnowledge) => void
}): ReactElement {
  const [scopeFilter, setScopeFilter] = useState<"all" | "workspace" | "project">("all")
  const [editing, setEditing] = useState(false)
  const [sumDraft, setSumDraft] = useState("")
  const [bodyDraft, setBodyDraft] = useState("")

  const memberById = new Map(members.map(m => [m.userId, m]))
  const list = knowledge.filter(k => scopeFilter === "all" || k.scope === scopeFilter)
  const cur = list.find(k => k.id === selectedId) ?? list[0] ?? null

  useEffect(() => {
    setEditing(false)
  }, [cur?.id, scopeFilter])

  const beginEdit = () => {
    if (!cur) return
    setSumDraft(cur.sum)
    setBodyDraft(cur.body || cur.sum)
    setEditing(true)
  }

  return (
    <div className="collab-page-stage">
      <div className="page-head">
        <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
          <h1>团队知识库</h1>
          <span className="sub">{workspaceName} 的公共规约，加上 {projectName} 的项目沉淀</span>
        </div>
        <span className="spacer" />
        <div className="seg" role="tablist" aria-label="知识作用域">
          {([
            ["all", "全部可用"],
            ["workspace", "Workspace 公共规约"],
            ["project", "本项目沉淀"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={scopeFilter === id ? "is-active" : undefined}
              aria-selected={scopeFilter === id}
              onClick={() => setScopeFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onCreateClick}>
          <PlusIcon size={14} />
          <span>新建知识</span>
        </button>
      </div>

      {!list.length || !cur ? (
        <div className="empty-block">
          <span className="eb-title">这个作用域下还没有知识</span>
          <span className="eb-body">切到「全部可用」看看，或者新建一条知识。</span>
        </div>
      ) : (
        <div className="knowledge-layout">
          <div className="k-side" role="list">
            {list.map(k => {
              const active = k.id === cur.id
              return (
                <button
                  key={k.id}
                  type="button"
                  className={`k-row${active ? " is-active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(k.id)}
                >
                  <span className="kr-title">{k.title}</span>
                  <span className="kr-meta">
                    <span className={`scope-tag ${k.scope}`}>{k.scope === "workspace" ? "Workspace 团队" : "本项目"}</span>
                    <span>{k.version}</span>
                    <span>·</span>
                    <span>{k.updated}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <article className="k-doc">
            <div className="od-row" style={{ ["--od-gap" as string]: "8px", flexWrap: "wrap" }}>
              <span className={`scope-tag ${cur.scope}`}>{cur.scope === "workspace" ? "Workspace 团队" : "本项目"}</span>
              <span className="meta mono">{cur.version}</span>
              <span className="meta">{cur.updated} 更新</span>
              <span style={{ flex: "1 1 0" }} />
              {editing ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      onSaveEdit(cur.id, sumDraft, bodyDraft)
                      setEditing(false)
                    }}
                  >
                    保存并升级版本
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>取消</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={beginEdit}>编辑</button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title="把这条知识插入到本机会话输入框"
                    onClick={() => onCiteToSession(cur)}
                  >
                    <AtSignIcon size={14} />
                    <span>引用到会话</span>
                  </button>
                </>
              )}
            </div>

            <h2>{cur.title}</h2>

            {editing ? (
              <>
                <input
                  type="text"
                  className="k-sum-edit"
                  aria-label="一句话结论"
                  value={sumDraft}
                  placeholder="概括这条知识约束了什么"
                  onChange={e => setSumDraft(e.currentTarget.value)}
                />
                <textarea
                  className="k-body-edit"
                  aria-label="知识正文"
                  value={bodyDraft}
                  onChange={e => setBodyDraft(e.currentTarget.value)}
                />
              </>
            ) : (
              <>
                <p className="k-sum">{cur.sum}</p>
                <p className="k-body">{cur.body || cur.sum}</p>
              </>
            )}

            <div className="k-hist">
              <span className="kh-title">版本历史</span>
              <div className="k-hist-row">
                <UserAvatar user={memberById.get(cur.authorUserId)} name="成员" size={22} />
                <span>{cur.version}</span>
                <span className="meta">{memberById.get(cur.authorUserId)?.userName ?? "团队成员"} · {cur.updated}</span>
                <span className="role-tag" style={{ marginLeft: "auto" }}>当前</span>
              </div>
              <span className="k-hist-note">会话引用会锁定当前版本号；每次保存更新会自动递增小版本，保证历史会话可溯源。</span>
            </div>
          </article>
        </div>
      )}
    </div>
  )
}
