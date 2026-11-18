/**
 * 顶栏协作成员浮层与 ⌘K 全局搜索命令面板。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import type { KnowledgeSummary, TaskStatus, TaskSummary } from "@workbench/contracts"
import type { NavigationMember, NavigationSessionEntry } from "@workbench/ui"
import { resolveFallbackDemoAvatar, resolveUserPhoto } from "../../demo-avatars.js"
import { IconBook, IconChevronDown, IconListCheck, IconLock, IconSearch, IconX } from "@tabler/icons-react"

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待接收",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
}

/** 仅透传服务端返回的所属团队/组织名称，不在前端预设岗位角色。 */
export function memberRoleLabel(member?: { readonly orgName?: string | null } | null): string {
  return member?.orgName || ""
}

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

/** 顶栏「协作成员」触发器：叠放最多 3 个 22px 队友头像（带更新小圆点）+ 成员总人数 + 更新圆点 + 下拉箭头。 */
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
  const anyUpd = mates.some(m => hasUpd(m.userId))

  return (
    <button
      type="button"
      className="collab-btn"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title="协作成员与队友会话"
      aria-label={`协作成员 ${members.length} 人${anyUpd ? " · 有更新" : ""}`}
      onClick={onClick}
    >
      <span className="av-stack">
        {mates.slice(0, 3).map(m => (
          <span key={m.userId} className="av-dot-wrap">
            <UserAvatar user={m} size={22} />
            {hasUpd(m.userId) && <span className="av-dot" aria-hidden="true" />}
          </span>
        ))}
      </span>
      <span className="collab-count">{members.length}</span>
      {anyUpd && <span className="collab-dot" aria-hidden="true" />}
      <span className="collab-chev" aria-hidden="true">
        <IconChevronDown className="od-icon" size={12} aria-hidden="true" />
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
              <IconX size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="pop-search">
            <IconSearch size={14} aria-hidden="true" />
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
                    {memberRoleLabel(m) && <span className="pm-role">{memberRoleLabel(m)}</span>}
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
          <IconLock size={12} aria-hidden="true" />
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

/** ⌘K 全局搜索命令面板。 */
export function CommandPaletteModal({
  open,
  projectName,
  members,
  mySessions,
  peerSessions,
  tasks,
  knowledge,
  onClose,
  onSelectSession,
  onSelectTask,
  onSelectKnowledge,
}: {
  readonly open: boolean
  readonly projectName: string
  readonly members: readonly NavigationMember[]
  readonly mySessions: readonly NavigationSessionEntry[]
  readonly peerSessions: readonly NavigationSessionEntry[]
  readonly tasks: readonly TaskSummary[]
  readonly knowledge: readonly KnowledgeSummary[]
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
  const activeKnowledge = useMemo(() => knowledge.filter(item => !item.archived), [knowledge])

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

    const tks = tasks.filter(t => {
      const assigneeName = memberById.get(t.assigneeId)?.userName ?? ""
      return hit(t.title) || hit(assigneeName)
    }).slice(0, cap)
    if (tks.length) {
      out.push({
        label: "任务",
        items: tks.map(t => ({
          kind: "task",
          id: t.taskId,
          title: t.title,
          sub: `${projectName} · ${TASK_STATUS_LABEL[t.status]}`,
          user: memberById.get(t.assigneeId),
        })),
      })
    }

    const kbs = activeKnowledge.filter(k => hit(k.title) || hit(k.category) || hit(k.termKey)).slice(0, cap)
    if (kbs.length) {
      out.push({
        label: "知识",
        items: kbs.map(k => ({
          kind: "knowledge",
          id: k.knowledgeId,
          title: k.title,
          sub: `${k.category ? `${k.category} · ` : ""}v${k.version}`,
        })),
      })
    }

    return out
  }, [query, mySessions, peerSessions, tasks, activeKnowledge, projectName, memberById])

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

  const totalAll = mySessions.length + peerSessions.length + tasks.length + activeKnowledge.length
  let flatIdx = 0

  return (
    <div className="palette-wrap" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="palette-input">
          <IconSearch size={16} aria-hidden="true" />
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
                          <IconBook size={15} aria-hidden="true" />
                        ) : (
                          <IconListCheck size={15} aria-hidden="true" />
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

