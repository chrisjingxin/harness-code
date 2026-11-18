/**
 * 顶栏协作成员浮层、⌘K 全局搜索命令面板、以及任务/知识弹窗（1:1 还原原型稿）。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import type { NavigationMember, NavigationSessionEntry } from "@workbench/ui"
import { resolveFallbackDemoAvatar, resolveUserPhoto } from "../../demo-avatars.js"
import { BookOpenIcon, CloseIcon, LockIcon, SearchIcon, TaskIcon } from "./collab-icons.js"
import { memberRoleLabel } from "./collab-store.js"
import type { CollabKnowledgeScope, CollabTask } from "./collab-store.js"

export function UserAvatar({
  user,
  name,
  size = 26,
  self,
}: {
  readonly user?: { readonly userNo?: string | null; readonly userName?: string | null; readonly photo?: string | null } | null
  readonly name?: string
  readonly size?: number
  readonly self?: boolean
}): ReactElement {
  const [failedPrimary, setFailedPrimary] = useState(false)
  const [failedFallback, setFailedFallback] = useState(false)
  const displayName = user?.userName ?? name ?? "?"
  const primary = user ? resolveUserPhoto(user) : null
  const fallback = user ? resolveFallbackDemoAvatar(user) : null
  const url = !failedPrimary && primary
    ? primary
    : !failedFallback && fallback && fallback !== primary
      ? fallback
      : null
  if (url) {
    return (
      <img
        className="av"
        src={url}
        alt={displayName}
        width={size}
        height={size}
        style={{ ["--av" as string]: `${size}px` }}
        onError={() => {
          if (!failedPrimary && url === primary) setFailedPrimary(true)
          else setFailedFallback(true)
        }}
      />
    )
  }
  return (
    <span
      className="av-fallback"
      data-self={self ? "true" : "false"}
      aria-hidden="true"
      style={{ ["--av" as string]: `${size}px`, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {displayName.slice(0, 1)}
    </span>
  )
}

function syncToneOf(entry: NavigationSessionEntry): { cls: "updated" | "unsynced" | "synced" | "failed"; text: string; dot: boolean } {
  const txt = entry.badge?.text ?? "已同步"
  if (txt.includes("有更新")) return { cls: "updated", text: txt, dot: true }
  if (txt.includes("未同步") || txt.includes("简报")) return { cls: "unsynced", text: txt, dot: false }
  if (txt.includes("失败")) return { cls: "failed", text: txt, dot: false }
  return { cls: "synced", text: txt, dot: false }
}

/** 顶栏「协作成员」触发器：叠放队友头像（带更新小圆点）+ 成员总人数 + 下拉箭头。 */
export function TopbarCollabButton({
  members,
  selfUserId,
  peerEntries,
  expanded,
  onClick,
}: {
  readonly members: readonly NavigationMember[]
  readonly selfUserId: string
  readonly peerEntries: readonly NavigationSessionEntry[]
  readonly expanded: boolean
  readonly onClick: () => void
}): ReactElement {
  const mates = members.filter(m => m.userId !== selfUserId)
  const hasUpd = (uid: string) => peerEntries.some(e => e.ownerUserId === uid && e.badge?.tone === "warning")

  return (
    <button
      type="button"
      className="collab-btn"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title="协作成员与队友会话"
      aria-label={`协作成员 ${members.length}`}
      onClick={onClick}
    >
      <span className="av-stack">
        {mates.slice(0, 5).map(m => (
          <span key={m.userId} className="av-dot-wrap">
            <UserAvatar user={m} size={24} />
            {hasUpd(m.userId) && <span className="av-dot" aria-hidden="true" />}
          </span>
        ))}
      </span>
      <span className="collab-count">协作成员 {members.length}</span>
      <span className="collab-chev">
        <svg className="od-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </span>
    </button>
  )
}

/** 顶栏右上角 560px 双栏浮层：左栏按成员筛选，右栏按状态筛选队友只读会话。 */
export function CollabMembersPopover({
  open,
  projectName,
  members,
  selfUserId,
  peerEntries,
  onClose,
  onOpenConversation,
}: {
  readonly open: boolean
  readonly projectName: string
  readonly members: readonly NavigationMember[]
  readonly selfUserId: string
  readonly peerEntries: readonly NavigationSessionEntry[]
  readonly onClose: () => void
  readonly onOpenConversation: (conversationId: string) => void
}): ReactElement | null {
  const [ownerFilter, setOwnerFilter] = useState<string>("all")
  const [syncFilter, setSyncFilter] = useState<"all" | "updated" | "unsynced">("all")
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setOwnerFilter("all")
    setSyncFilter("all")
    setQuery("")
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [open, onClose])

  if (!open) return null

  const memberById = new Map(members.map(m => [m.userId, m]))
  const q = query.trim().toLowerCase()
  const mates = members.filter(m => {
    if (m.userId === selfUserId) return false
    if (!q) return true
    if (m.userName.toLowerCase().includes(q)) return true
    return peerEntries.some(e => e.ownerUserId === m.userId && e.title.toLowerCase().includes(q))
  })

  const filteredSessions = peerEntries.filter(entry => {
    if (ownerFilter !== "all" && entry.ownerUserId !== ownerFilter) return false
    const st = syncToneOf(entry)
    if (syncFilter === "updated" && st.cls !== "updated") return false
    if (syncFilter === "unsynced" && st.cls !== "unsynced") return false
    if (!q) return true
    const ownerName = memberById.get(entry.ownerUserId)?.userName ?? ""
    return entry.title.toLowerCase().includes(q) || ownerName.toLowerCase().includes(q)
  })

  return (
    <>
      <div className="collab-popover-backdrop" onMouseDown={onClose} />
      <div className="popover" role="dialog" aria-label="协作成员与队友会话">
        <div className="pop-head">
          <div className="od-row" style={{ ["--od-gap" as string]: "6px" }}>
            <span className="eyebrow">{projectName} · 协作成员</span>
            <span className="meta od-nowrap" style={{ marginLeft: "auto" }}>{filteredSessions.length} 条</span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
              <CloseIcon size={15} />
            </button>
          </div>
          <div className="pop-search">
            <SearchIcon size={14} />
            <input
              ref={inputRef}
              type="text"
              placeholder="搜成员姓名或会话标题"
              value={query}
              onChange={e => setQuery(e.currentTarget.value)}
            />
          </div>
        </div>

        <div className="pop-body">
          <div className="pop-members" role="group" aria-label="按成员筛选">
            <span className="pop-members-label">成员</span>
            <button
              type="button"
              className={`pop-member${ownerFilter === "all" ? " is-active" : ""}`}
              onClick={() => setOwnerFilter("all")}
            >
              <span className="av-fallback" style={{ ["--av" as string]: "24px" }} aria-hidden="true">全</span>
              <span className="pm-body">
                <span className="pm-name">全部成员</span>
                <span className="pm-role">{members.length} 人 · 本项目</span>
              </span>
            </button>
            {mates.length > 0 ? mates.map(m => {
              const active = ownerFilter === m.userId
              const hasUpd = peerEntries.some(e => e.ownerUserId === m.userId && e.badge?.tone === "warning")
              return (
                <button
                  key={m.userId}
                  type="button"
                  className={`pop-member${active ? " is-active" : ""}`}
                  onClick={() => setOwnerFilter(m.userId)}
                >
                  <UserAvatar user={m} size={24} />
                  <span className="pm-body">
                    <span className="pm-name">
                      {m.userName}
                      {hasUpd && <span className="pm-dot" aria-hidden="true" />}
                    </span>
                    <span className="pm-role">{memberRoleLabel(m)}</span>
                  </span>
                </button>
              )
            }) : <span className="pop-empty" style={{ padding: "10px 8px" }}>没有匹配的成员</span>}
          </div>

          <div className="pop-main">
            <div className="pop-filters">
              <div className="seg" role="tablist" aria-label="按同步状态筛选">
                {([
                  ["all", "全部"],
                  ["updated", "有更新"],
                  ["unsynced", "未同步"],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className={syncFilter === id ? "is-active" : undefined}
                    aria-selected={syncFilter === id}
                    onClick={() => setSyncFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pop-list">
              {filteredSessions.length === 0 ? (
                <div className="pop-empty">
                  没有匹配的队友会话。
                  <br />
                  换个关键词，或者把筛选切回「全部」。
                </div>
              ) : filteredSessions.map(entry => {
                const owner = memberById.get(entry.ownerUserId)
                const st = syncToneOf(entry)
                return (
                  <button
                    key={entry.conversationId}
                    type="button"
                    className="pop-item"
                    onClick={() => {
                      onClose()
                      onOpenConversation(entry.conversationId)
                    }}
                  >
                    <UserAvatar user={owner} name={owner?.userName ?? "成员"} size={28} />
                    <span className="pi-main">
                      <span className="pi-title">{entry.title}</span>
                      <span className="pi-meta">{owner?.userName ?? "团队成员"} · {entry.timeLabel}</span>
                    </span>
                    <span className="pi-side">
                      <span className={`sync-mark ${st.cls}`}>
                        {st.dot && <span className="d" aria-hidden="true" />}
                        {st.text}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="pop-foot">
          <LockIcon size={12} />
          <span>会话同步是 Project 维度的，拿到的都是只读快照</span>
        </div>
      </div>
    </>
  )
}

type PaletteItem =
  | { kind: "session"; id: string; title: string; sub: string; user?: NavigationMember; self?: boolean }
  | { kind: "task"; id: string; title: string; sub: string; user?: NavigationMember }
  | { kind: "knowledge"; id: string; title: string; sub: string; user?: NavigationMember }

/** 搜索任务只使用服务端摘要中的标题、状态和被指派人。 */
export type PaletteTaskSummary = { readonly id: string; readonly title: string; readonly statusLabel: string; readonly assigneeId: string }
/** 知识搜索使用条目与版本摘要；正文在用户打开后读取。 */
export type PaletteKnowledgeSummary = { readonly id: string; readonly title: string; readonly category: string; readonly version: number }

/** ⌘K 全局搜索命令面板。 */
export function CommandPaletteModal({
  open,
  projectName,
  members,
  selfUserId,
  mySessions,
  peerSessions,
  tasks,
  knowledge,
  metadataMessage,
  onClose,
  onSelectSession,
  onSelectTask,
  onSelectKnowledge,
}: {
  readonly open: boolean
  readonly projectName: string
  readonly members: readonly NavigationMember[]
  readonly selfUserId: string
  readonly mySessions: readonly NavigationSessionEntry[]
  readonly peerSessions: readonly NavigationSessionEntry[]
  readonly tasks: readonly PaletteTaskSummary[]
  readonly knowledge: readonly PaletteKnowledgeSummary[]
  readonly metadataMessage?: string
  readonly onClose: () => void
  readonly onSelectSession: (conversationId: string) => void
  readonly onSelectTask: (taskId: string) => void
  readonly onSelectKnowledge: (knowledgeId: string) => void
}): ReactElement | null {
  const [query, setQuery] = useState("")
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery("")
    setActiveIdx(0)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const memberById = useMemo(() => new Map(members.map(m => [m.userId, m])), [members])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cap = q ? 20 : 3
    const hit = (txt: string) => !q || txt.toLowerCase().includes(q)
    const out: { label: string; items: PaletteItem[] }[] = []

    const mine = mySessions.filter(s => hit(s.title)).slice(0, cap)
    if (mine.length) {
      out.push({
        label: q ? "我的会话" : "当前 Project 会话",
        items: mine.map(s => ({
          kind: "session",
          id: s.conversationId,
          title: s.title,
          sub: `${projectName} · ${s.timeLabel}`,
          user: memberById.get(s.ownerUserId),
          self: true,
        })),
      })
    }

    const peers = peerSessions.filter(s => {
      const ownerName = memberById.get(s.ownerUserId)?.userName ?? ""
      return hit(s.title) || hit(ownerName)
    }).slice(0, cap)
    if (peers.length) {
      out.push({
        label: "队友会话（只读）",
        items: peers.map(s => {
          const owner = memberById.get(s.ownerUserId)
          return {
            kind: "session",
            id: s.conversationId,
            title: s.title,
            sub: `${owner?.userName ?? "成员"} · ${projectName}`,
            user: owner,
          }
        }),
      })
    }

    const tks = tasks.filter(t => hit(t.title)).slice(0, cap)
    if (tks.length) {
      out.push({
        label: "任务",
        items: tks.map(t => ({
          kind: "task",
          id: t.id,
          title: t.title,
          sub: `${projectName} · ${t.statusLabel}`,
          user: memberById.get(t.assigneeId),
        })),
      })
    }

    const kbs = knowledge.filter(k => hit(k.title) || hit(k.category)).slice(0, cap)
    if (kbs.length) {
      out.push({
        label: "知识",
        items: kbs.map(k => ({
          kind: "knowledge",
          id: k.id,
          title: k.title,
          sub: `团队知识 · ${k.category} · v${k.version}`,
        })),
      })
    }

    return out
  }, [query, mySessions, peerSessions, tasks, knowledge, projectName, memberById])

  const flatItems = useMemo(() => groups.flatMap(g => g.items), [groups])

  const activateItem = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    if (item.kind === "session") onSelectSession(item.id)
    else if (item.kind === "task") onSelectTask(item.id)
    else onSelectKnowledge(item.id)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (!flatItems.length) return
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIdx(prev => (prev + (e.key === "ArrowDown" ? 1 : flatItems.length - 1)) % flatItems.length)
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault()
        activateItem(flatItems[activeIdx] ?? flatItems[0])
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [open, flatItems, activeIdx])

  if (!open) return null

  const totalAll = mySessions.length + peerSessions.length + tasks.length + knowledge.length
  let flatIdx = 0

  return (
    <div className="palette-wrap" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="palette-input">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索会话、任务、知识"
            value={query}
            onChange={e => { setQuery(e.currentTarget.value); setActiveIdx(0) }}
          />
          <span className="kbd">Esc</span>
        </div>

        <div className="palette-list" role="listbox" aria-label="搜索结果">
          {metadataMessage && <div className="p-hint" role="status">{metadataMessage}</div>}
          {groups.length === 0 ? (
            <div className="pop-empty">
              没有匹配的内容。
              <br />
              试试会话标题、成员名或知识关键词。
            </div>
          ) : (
            <>
              {!query.trim() && (
                <div className="p-hint">默认优先显示当前 Project 最近项 · 输入关键词可搜索全部 {totalAll} 条记录</div>
              )}
              {groups.map(group => (
                <div key={group.label}>
                  <div className="p-group">{group.label}</div>
                  {group.items.map(item => {
                    const idx = flatIdx++
                    const hl = idx === activeIdx
                    return (
                      <button
                        key={`${item.kind}:${item.id}`}
                        type="button"
                        className={`p-item${hl ? " is-hl" : ""}`}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => activateItem(item)}
                      >
                        {item.user ? (
                          <UserAvatar user={item.user} size={22} self={item.kind === "session" && item.self} />
                        ) : item.kind === "knowledge" ? (
                          <BookOpenIcon size={15} />
                        ) : (
                          <TaskIcon size={15} />
                        )}
                        <span className="p-main">
                          <span className="p-t">{item.title}</span>
                          <span className="p-s">{item.sub}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 「在本机开始」任务启动弹窗（#dlgStart）。 */
export function StartTaskDialog({
  task,
  localSessions,
  onClose,
  onConfirm,
}: {
  readonly task: CollabTask | null
  readonly localSessions: readonly NavigationSessionEntry[]
  readonly onClose: () => void
  readonly onConfirm: (result: { mode: "existing" | "new"; existingSessionId?: string }) => void
}): ReactElement | null {
  const [mode, setMode] = useState<"existing" | "new">(localSessions.length ? "existing" : "new")
  const [pickedId, setPickedId] = useState<string>(localSessions[0]?.conversationId ?? "")

  useEffect(() => {
    setMode(localSessions.length ? "existing" : "new")
    setPickedId(localSessions[0]?.conversationId ?? "")
  }, [task?.id, localSessions.length])

  if (!task) return null

  return (
    <div className="dlg-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlgStartTitle"
        onSubmit={e => {
          e.preventDefault()
          onConfirm(mode === "existing" ? { mode: "existing", existingSessionId: pickedId } : { mode: "new" })
        }}
      >
        <div className="dlg-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h2 id="dlgStartTitle">在本机开始</h2>
            <p className="dlg-sub">{task.title}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto" }}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="dlg-body">
          <div className="fld">
            <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>选择执行会话</span>
            <div className="choice-list" role="radiogroup">
              <label className={`choice${mode === "existing" ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="startMode"
                  checked={mode === "existing"}
                  disabled={!localSessions.length}
                  onChange={() => setMode("existing")}
                />
                <span className="c-main">
                  <span className="c-t">在已有本机会话中继续</span>
                  <span className="c-d">
                    {localSessions.length ? `保留原对话与工作目录，共 ${localSessions.length} 个可用` : "当前项目暂无本机会话"}
                  </span>
                </span>
              </label>
              <label className={`choice${mode === "new" ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="startMode"
                  checked={mode === "new"}
                  onChange={() => setMode("new")}
                />
                <span className="c-main">
                  <span className="c-t">前往新对话准备页创建</span>
                  <span className="c-d">自选工作目录与指令后，在本机启动全新会话</span>
                </span>
              </label>
            </div>
          </div>

          {mode === "existing" && localSessions.length > 0 && (
            <div className="fld">
              <label htmlFor="startPickSelect">已有会话</label>
              <select
                id="startPickSelect"
                value={pickedId}
                onChange={e => setPickedId(e.currentTarget.value)}
              >
                {localSessions.map(s => (
                  <option key={s.conversationId} value={s.conversationId}>{s.title}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="dlg-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary">开始执行</button>
        </div>
      </form>
    </div>
  )
}

/** 「新建知识」弹窗（#dlgKnowledge）。 */
export function KnowledgeCreateDialog({
  open,
  projectName,
  onClose,
  onSubmit,
}: {
  readonly open: boolean
  readonly projectName: string
  readonly onClose: () => void
  readonly onSubmit: (input: { title: string; sum: string; body: string; scope: CollabKnowledgeScope }) => void
}): ReactElement | null {
  const [title, setTitle] = useState("")
  const [sum, setSum] = useState("")
  const [body, setBody] = useState("")
  const [scope, setScope] = useState<CollabKnowledgeScope>("project")
  const [err, setErr] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle("")
    setSum("")
    setBody("")
    setScope("project")
    setErr("")
    const t = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  return (
    <div className="dlg-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlgKnowTitle"
        onSubmit={e => {
          e.preventDefault()
          if (!title.trim()) {
            setErr("请填写知识标题。")
            titleRef.current?.focus()
            return
          }
          onSubmit({ title: title.trim(), sum: sum.trim(), body: body.trim(), scope })
        }}
      >
        <div className="dlg-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h2 id="dlgKnowTitle">新建知识</h2>
            <p className="dlg-sub">{projectName}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto" }}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="dlg-body">
          <div className="fld">
            <label htmlFor="knowTitle">标题<span className="req" aria-hidden="true">*</span></label>
            <input
              ref={titleRef}
              id="knowTitle"
              type="text"
              placeholder="例如：支付回调幂等键约定"
              value={title}
              onChange={e => { setTitle(e.currentTarget.value); setErr("") }}
            />
            {err && <p className="err">{err}</p>}
          </div>
          <div className="fld">
            <label htmlFor="knowSum">一句话结论</label>
            <input id="knowSum" type="text" placeholder="概括这条知识约束了什么" value={sum} onChange={e => setSum(e.currentTarget.value)} />
          </div>
          <div className="fld">
            <label htmlFor="knowBody">详细规范 / 正文</label>
            <textarea id="knowBody" placeholder="写明触发条件、代码规范或字段约定，供团队与 Agent 直接执行" value={body} onChange={e => setBody(e.currentTarget.value)} />
          </div>
          <div className="fld">
            <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>归属</span>
            <div className="choice-list" role="radiogroup">
              <label className={`choice${scope === "project" ? " is-on" : ""}`}>
                <input type="radio" name="kscope" checked={scope === "project"} onChange={() => setScope("project")} />
                <span className="c-main">
                  <span className="c-t">仅当前 Project</span>
                  <span className="c-d">只随这个项目沉淀，别的项目看不到</span>
                </span>
              </label>
              <label className={`choice${scope === "workspace" ? " is-on" : ""}`}>
                <input type="radio" name="kscope" checked={scope === "workspace"} onChange={() => setScope("workspace")} />
                <span className="c-main">
                  <span className="c-t">Workspace 团队共享</span>
                  <span className="c-d">当前 Workspace 下所有项目通用</span>
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="dlg-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary">保存知识</button>
        </div>
      </form>
    </div>
  )
}

/** 「@成员 派发任务」弹窗（#dlgDispatch）。 */
export function DispatchTaskDialog({
  open,
  subtitle,
  members,
  defaultAssigneeId,
  onClose,
  onSubmit,
}: {
  readonly open: boolean
  readonly subtitle: string
  readonly members: readonly NavigationMember[]
  readonly defaultAssigneeId?: string
  readonly onClose: () => void
  readonly onSubmit: (input: { title: string; toUserId: string; desc: string }) => void
}): ReactElement | null {
  const [title, setTitle] = useState("")
  const [toUserId, setToUserId] = useState(defaultAssigneeId ?? members[0]?.userId ?? "")
  const [desc, setDesc] = useState("")
  const [err, setErr] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle("")
    setDesc("")
    setErr("")
    setToUserId(defaultAssigneeId ?? members[0]?.userId ?? "")
    const t = window.setTimeout(() => titleRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, defaultAssigneeId, members])

  if (!open) return null

  return (
    <div className="dlg-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <form
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlgDispatchTitle"
        onSubmit={e => {
          e.preventDefault()
          if (!title.trim()) {
            setErr("请填写任务标题。")
            titleRef.current?.focus()
            return
          }
          onSubmit({ title: title.trim(), toUserId: toUserId || members[0]?.userId || "", desc: desc.trim() })
        }}
      >
        <div className="dlg-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h2 id="dlgDispatchTitle">@成员 派发任务</h2>
            <p className="dlg-sub">{subtitle}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto" }}>
            <CloseIcon size={15} />
          </button>
        </div>

        <div className="dlg-body">
          <div className="fld">
            <label htmlFor="disTitle">任务标题<span className="req" aria-hidden="true">*</span></label>
            <input
              ref={titleRef}
              id="disTitle"
              type="text"
              placeholder="例如：支付方式列表接口补 3 个字段"
              value={title}
              onChange={e => { setTitle(e.currentTarget.value); setErr("") }}
            />
            {err && <p className="err">{err}</p>}
          </div>
          <div className="fld">
            <label htmlFor="disTo">指派给</label>
            <select id="disTo" value={toUserId} onChange={e => setToUserId(e.currentTarget.value)}>
              {members.map(m => (
                <option key={m.userId} value={m.userId}>{m.userName} · {memberRoleLabel(m)}</option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="disDesc">背景说明</label>
            <textarea id="disDesc" placeholder="为什么需要这个改动、验收标准是什么" value={desc} onChange={e => setDesc(e.currentTarget.value)} />
          </div>
        </div>

        <div className="dlg-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary">派发任务</button>
        </div>
      </form>
    </div>
  )
}
