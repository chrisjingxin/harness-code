/**
 * 【功能定义】桌面全局收件箱中央主视图（对齐 LoopForge 风格宽屏双栏主从审阅 + 方案 A 本机安全隔离）：
 * 1. 页头无眉标，右侧分段标签切换「待我处理 / 我发起的 / 已处理」；
 * 2. 顶部动态置顶「本机等待你确认」提醒条：仅收集非当前查看的 `waiting_approval` / `error` 会话并强制「回到会话处理」，绝不混算云端角标；
 * 3. 主区采用 `0.82fr / 1.18fr` 双栏主从审阅布局：左侧紧凑待办列表，右侧展示任务说明、材料数、流转记录与就地快捷拍板动作（接受/通过验收/退回修订/取消），并保留「在项目任务中打开」完整视图入口。
 */
import { useEffect, useMemo, useState } from "react"
import type { KeyboardEvent } from "react"
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconExternalLink,
  IconInbox,
  IconRefresh,
  IconWifiOff,
} from "@tabler/icons-react"
import type { InboxBucket, InboxItem, InboxResponse, WorkspaceSummary } from "@workbench/collaboration-client/types"
import type { CollaborationAppsHost } from "../../../shared/index.js"
import {
  INBOX_BUCKETS,
  badgeToneForCategory,
  badgeToneForTaskStatus,
  formatInboxCategoryLabel,
  formatInboxTaskStatusLabel,
  formatRelativeTime,
  resolveInboxTaskActions,
  resolveSelectedInboxItemKey,
  type LocalAttentionItem,
} from "./inbox-model.js"
import type { InboxStreamState } from "./use-inbox.js"
import { useInboxTaskDetail } from "./use-inbox-task-detail.js"
import "./inbox.css"

export type InboxPageProps = {
  readonly currentUserId: string
  readonly collaborationApps?: CollaborationAppsHost
  readonly online: boolean
  readonly workspaces: readonly WorkspaceSummary[]
  readonly localItems: readonly LocalAttentionItem[]
  readonly bucket: InboxBucket
  readonly workspaceFilter: string
  readonly categoryFilter: string
  readonly data: InboxResponse | null
  readonly loading: boolean
  readonly refreshing: boolean
  readonly error: string
  readonly streamStatus: InboxStreamState
  onChangeBucket(bucket: InboxBucket): void
  onChangeWorkspaceFilter(workspaceId: string): void
  onChangeCategoryFilter(category: string): void
  onRefresh(): void
  onReconnect(): void
  onOpenLocalItem(item: LocalAttentionItem): void
  onOpenCloudItem(item: InboxItem): void
  onTaskMutated?(toastMessage?: string): void
}

function streamStatusLabel(status: InboxStreamState): string {
  switch (status) {
    case "connected":
      return "实时同步"
    case "connecting":
      return "连接中…"
    case "retrying":
      return "断线重连中…"
    case "unavailable":
      return "同步暂不可用"
    case "offline":
      return "已离线"
  }
}

export function InboxPage(props: InboxPageProps) {
  const {
    currentUserId,
    collaborationApps,
    online,
    workspaces,
    localItems,
    bucket,
    workspaceFilter,
    categoryFilter,
    data,
    loading,
    refreshing,
    error,
    streamStatus,
  } = props

  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const actorsById = useMemo(
    () => new Map((data?.actors ?? []).map(actor => [actor.userId, actor])),
    [data?.actors],
  )
  const workspacesById = useMemo(() => {
    const map = new Map<string, string>()
    for (const ws of workspaces) map.set(ws.id, ws.name)
    for (const ws of data?.workspaces ?? []) map.set(ws.workspaceId, ws.name)
    return map
  }, [workspaces, data?.workspaces])

  const workspaceOptions = useMemo(() => {
    if (data?.workspaces?.length) return data.workspaces
    return workspaces.map(w => ({ workspaceId: w.id, name: w.name, slug: w.slug }))
  }, [data?.workspaces, workspaces])

  const categoryOptions = useMemo(() => {
    const ordered: string[] = ["task_review", "task_assigned"]
    for (const item of data?.items ?? []) {
      if (item.category && !ordered.includes(item.category)) ordered.push(item.category)
    }
    if (categoryFilter && !ordered.includes(categoryFilter)) ordered.push(categoryFilter)
    return ordered
  }, [data?.items, categoryFilter])

  const cloudItems = data?.items ?? []
  const counts = data?.counts

  const effectiveSelectedKey = useMemo(
    () => resolveSelectedInboxItemKey(cloudItems, selectedKey),
    [cloudItems, selectedKey],
  )

  useEffect(() => {
    if (effectiveSelectedKey !== selectedKey) setSelectedKey(effectiveSelectedKey)
  }, [effectiveSelectedKey, selectedKey])

  const selectedItem = useMemo(
    () => cloudItems.find(item => item.itemKey === effectiveSelectedKey) ?? null,
    [cloudItems, effectiveSelectedKey],
  )

  const taskDetail = useInboxTaskDetail({
    collaborationApps,
    item: selectedItem,
    online,
    onMutated: props.onTaskMutated,
  })

  const permissions = useMemo(
    () => selectedItem
      ? resolveInboxTaskActions({ item: selectedItem, detail: taskDetail.detail, currentUserId })
      : { canAccept: false, canReview: false, canCancel: false },
    [selectedItem, taskDetail.detail, currentUserId],
  )

  const resolveActorName = (userId: string) => {
    if (userId === currentUserId) return "我"
    return actorsById.get(userId)?.name ?? "团队成员"
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (cloudItems.length <= 1) return
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const idx = cloudItems.findIndex(item => item.itemKey === effectiveSelectedKey)
    if (idx < 0) return
    event.preventDefault()
    const nextIdx = event.key === "ArrowDown"
      ? Math.min(cloudItems.length - 1, idx + 1)
      : Math.max(0, idx - 1)
    setSelectedKey(cloudItems[nextIdx]!.itemKey)
  }

  const renderDetailPane = () => {
    if (!selectedItem) return null
    const wsName = workspacesById.get(selectedItem.workspaceId) ?? "团队"
    const location = selectedItem.projectName ? `${wsName} · ${selectedItem.projectName}` : wsName
    const actor = actorsById.get(selectedItem.actorId)
    const detail = taskDetail.detail
    const activeStatus = detail?.task.status ?? selectedItem.status
    const attachmentCount = detail ? detail.snapshotIds.length + detail.knowledgeRefs.length : 0
    const canTransition = Boolean(collaborationApps && online && detail)

    return (
      <article className="inbox-doc k-doc" aria-label="待办详情审阅">
        <div className="inbox-doc-bar">
          <span className="hui-badge" data-tone={badgeToneForCategory(selectedItem.category, selectedItem.urgency)}>
            {formatInboxCategoryLabel(selectedItem.category)}
          </span>
          <span className="hui-badge" data-tone={badgeToneForTaskStatus(activeStatus)}>
            {formatInboxTaskStatusLabel(activeStatus)}
          </span>
          {selectedItem.delegated && (
            <span className="hui-badge" data-tone="accent" title="原创建人已离开团队，由项目负责人代管验收">
              代管验收
            </span>
          )}
          <span className="inbox-doc-loc">{location}</span>
          <span className="inbox-doc-spacer" />
          {detail && <span className="hui-badge mono" data-tone="muted" data-size="xs">v{detail.task.version}</span>}
          {collaborationApps && online && (
            <button
              type="button"
              className="inbox-icon-btn"
              title="刷新任务详情"
              aria-label="刷新任务详情"
              disabled={taskDetail.loading || taskDetail.busy}
              onClick={taskDetail.reload}
            >
              <IconRefresh size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <h2 className="inbox-doc-title">{detail?.task.title ?? selectedItem.title}</h2>

        <div className="inbox-doc-people">
          {detail ? (
            <>
              <span>发布人：<strong>{resolveActorName(detail.task.creatorId)}</strong></span>
              {selectedItem.delegated && <span className="inbox-actor-left">（原成员已离开，由项目负责人代管）</span>}
              <span aria-hidden="true">·</span>
              <span>受让人：<strong>{resolveActorName(detail.task.assigneeId)}</strong></span>
            </>
          ) : (
            <span>
              发起/关联人：<strong>{resolveActorName(selectedItem.actorId)}</strong>
              {actor && !actor.active && <span className="inbox-actor-left">（原成员已离开）</span>}
            </span>
          )}
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(detail?.task.updatedAtMs ?? selectedItem.updatedAtMs)}</span>
          {attachmentCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>附带 {attachmentCount} 项固定材料</span>
            </>
          )}
        </div>

        <div className="inbox-doc-body">
          {!collaborationApps ? (
            <p className="inbox-muted">任务详情端口尚未接入，可点击下方按钮前往项目任务页处理。</p>
          ) : taskDetail.loading && !detail ? (
            <p className="inbox-muted" role="status">正在读取任务详情…</p>
          ) : taskDetail.loadError && !detail ? (
            <div className="inbox-doc-error" role="alert">
              <span>{taskDetail.loadError}</span>
              <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={taskDetail.reload}>
                重试
              </button>
            </div>
          ) : (
            <p className="inbox-doc-desc">
              {detail?.description?.trim() ? detail.description : "暂无补充任务说明。"}
            </p>
          )}
        </div>

        {taskDetail.loadError && detail && (
          <p className="inbox-inline-error" role="alert">{taskDetail.loadError}</p>
        )}
        {taskDetail.actionError && (
          <p className="inbox-inline-error" role="alert">{taskDetail.actionError}</p>
        )}

        <div className="inbox-doc-actions">
          {canTransition && permissions.canAccept && (
            <button
              type="button"
              className="wb-button wb-button-primary wb-button-small"
              disabled={taskDetail.busy}
              onClick={() => { void taskDetail.transition("doing") }}
            >
              {taskDetail.busy ? "处理中…" : "接受任务"}
            </button>
          )}

          {canTransition && permissions.canReview && (
            <div className="inbox-review-form">
              <input
                type="text"
                className="inbox-review-note"
                aria-label="验收或退回说明（可选）"
                placeholder="填写验收意见或退回原因（可选）…"
                value={taskDetail.note}
                disabled={taskDetail.busy}
                onChange={event => taskDetail.setNote(event.target.value)}
              />
              <button
                type="button"
                className="wb-button wb-button-primary wb-button-small"
                disabled={taskDetail.busy}
                onClick={() => { void taskDetail.transition("done") }}
              >
                通过验收
              </button>
              <button
                type="button"
                className="wb-button wb-button-danger wb-button-small"
                disabled={taskDetail.busy}
                onClick={() => { void taskDetail.transition("todo") }}
              >
                退回修订
              </button>
            </div>
          )}

          {canTransition && permissions.canCancel && (
            taskDetail.confirmingCancel ? (
              <div className="inbox-confirm-cancel">
                <button
                  type="button"
                  className="wb-button wb-button-danger wb-button-small"
                  disabled={taskDetail.busy}
                  onClick={() => { void taskDetail.transition("cancelled") }}
                >
                  确认取消任务
                </button>
                <button
                  type="button"
                  className="wb-button wb-button-quiet wb-button-small"
                  disabled={taskDetail.busy}
                  onClick={() => taskDetail.setConfirmingCancel(false)}
                >
                  放弃
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="wb-button wb-button-danger wb-button-small"
                disabled={taskDetail.busy}
                onClick={() => taskDetail.setConfirmingCancel(true)}
              >
                取消任务
              </button>
            )
          )}

          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small inbox-open-full"
            onClick={() => props.onOpenCloudItem(selectedItem)}
          >
            <span>在看板查看</span>
            <IconExternalLink size={13} aria-hidden="true" />
          </button>
        </div>

        {detail && detail.transitions.length > 0 && (
          <section className="inbox-transitions" aria-label="最近流转记录">
            <h3>最近流转</h3>
            <ol>
              {[...detail.transitions].reverse().slice(0, 5).map(tr => (
                <li key={tr.version}>
                  <div className="inbox-tr-line">
                    <span className="inbox-tr-actor">{resolveActorName(tr.actorId)}</span>
                    <span>{tr.fromStatus ? `${formatInboxTaskStatusLabel(tr.fromStatus)} → ` : ""}{formatInboxTaskStatusLabel(tr.toStatus)}</span>
                    <span className="hui-badge mono" data-tone="muted" data-size="xs">v{tr.version}</span>
                    <span className="inbox-time">{formatRelativeTime(tr.occurredAtMs)}</span>
                  </div>
                  {tr.note && <p className="inbox-tr-note">{tr.note}</p>}
                </li>
              ))}
            </ol>
          </section>
        )}
      </article>
    )
  }

  return (
    <section className="inbox-page" aria-label="收件箱">
      <div className="inbox-scroll">
        <div className="inbox-wrap page-wrap">
          {/* 1. 顶部方案 A 本机等待确认置顶区（绝不混入云端红点角标） */}
          {localItems.length > 0 && (
            <section className="inbox-local-banner" aria-label="本机等待你确认">
              <div className="inbox-local-head">
                <div className="inbox-local-title">
                  <IconAlertTriangle size={16} aria-hidden="true" />
                  <span>本机等待你确认（{localItems.length}）</span>
                </div>
                <span className="inbox-local-note">仅本机内存可见 · 不上云也不推送 IM，请回到原会话处理</span>
              </div>
              <ul className="inbox-local-list">
                {localItems.map(item => (
                  <li
                    key={item.conversationId}
                    className={`inbox-local-row${item.status === "error" ? " is-error" : ""}`}
                  >
                    <div className="inbox-local-main">
                      <div className="inbox-local-meta">
                        <span
                          className="hui-badge"
                          data-tone={item.status === "error" ? "danger" : "warn"}
                          data-size="xs"
                        >
                          {item.kindLabel}
                        </span>
                        <span className="inbox-local-loc">{item.locationLabel}</span>
                        <span className="inbox-time">{formatRelativeTime(item.updatedAtMs)}</span>
                      </div>
                      <div className="inbox-local-session">{item.title}</div>
                      <div className="inbox-local-summary">{item.summary}</div>
                    </div>
                    <button
                      type="button"
                      className="wb-button wb-button-primary wb-button-small inbox-local-cta"
                      onClick={() => props.onOpenLocalItem(item)}
                    >
                      <span>回到会话处理</span>
                      <IconArrowRight size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 2. LoopForge 风格无眉标页头 + 右侧分段标签 */}
          <header className="inbox-page-head page-head">
            <div>
              <h1>Inbox · 全局待办收件箱</h1>
              <p>收口跨团队任务指派与待验收拍板；本机工具审批留在原会话处理。</p>
            </div>
            <div className="inbox-seg seg" role="tablist" aria-label="收件箱分组">
              {INBOX_BUCKETS.map(tab => {
                const selected = bucket === tab.id
                const badgeCount = tab.id === "action_required"
                  ? counts?.actionRequired
                  : tab.id === "sent"
                    ? counts?.sent
                    : undefined
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={selected ? "is-active" : undefined}
                    onClick={() => props.onChangeBucket(tab.id)}
                  >
                    <span>{tab.label}</span>
                    {badgeCount !== undefined && badgeCount > 0 && (
                      <span className={`inbox-seg-count${tab.id === "action_required" ? " is-strong" : ""}`}>
                        {badgeCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </header>

          {/* 3. LoopForge 筛选与状态工具栏 */}
          <div className="inbox-view-bar view-bar">
            {online && workspaceOptions.length > 0 && (
              <div className="inbox-cat-pills" role="group" aria-label="按类别筛选">
                <button
                  type="button"
                  className={`inbox-filter-btn${categoryFilter === "" ? " is-soft" : ""}`}
                  aria-pressed={categoryFilter === ""}
                  onClick={() => props.onChangeCategoryFilter("")}
                >
                  全部
                </button>
                {categoryOptions.map(cat => (
                  <button
                    key={cat}
                    type="button"
                    className={`inbox-filter-btn${categoryFilter === cat ? " is-soft" : ""}`}
                    aria-pressed={categoryFilter === cat}
                    onClick={() => props.onChangeCategoryFilter(cat)}
                  >
                    {formatInboxCategoryLabel(cat)}
                  </button>
                ))}
              </div>
            )}

            <div className="inbox-bar-right">
              {bucket === "resolved" && (
                <span className="inbox-bucket-note">近 30 天记录</span>
              )}
              {online && workspaceOptions.length >= 2 && (
                <label className="inbox-ws-filter">
                  <span>团队</span>
                  <select
                    aria-label="按团队筛选"
                    value={workspaceFilter}
                    onChange={event => props.onChangeWorkspaceFilter(event.target.value)}
                  >
                    <option value="">全部团队（{workspaceOptions.length}）</option>
                    {workspaceOptions.map(ws => (
                      <option key={ws.workspaceId} value={ws.workspaceId}>{ws.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <span className={`inbox-stream-pill is-${streamStatus}`} role="status">
                <span className="inbox-stream-dot" aria-hidden="true" />
                <span>{streamStatusLabel(streamStatus)}</span>
              </span>
              {online && (
                <button
                  type="button"
                  className="wb-button wb-button-secondary wb-button-small"
                  disabled={refreshing || loading}
                  onClick={props.onRefresh}
                >
                  <IconRefresh size={13} aria-hidden="true" />
                  <span>{refreshing ? "刷新中…" : "刷新"}</span>
                </button>
              )}
            </div>
          </div>

          {/* 4. 离线 / 未入团 / 异常 / 双栏主从审阅 */}
          {!online ? (
            <div className="inbox-empty-block" role="status">
              <IconWifiOff size={22} aria-hidden="true" />
              <strong>当前处于离线状态</strong>
              <p>加入团队或重连协作服务后，这里会汇总跨团队任务与验收待办；本机待确认会话仍可在上方置顶区或个人空间处理。</p>
              <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={props.onReconnect}>
                <IconRefresh size={13} aria-hidden="true" />
                <span>重连服务</span>
              </button>
            </div>
          ) : workspaces.length === 0 ? (
            <div className="inbox-empty-block" role="status">
              <IconInbox size={22} aria-hidden="true" />
              <strong>尚未加入协作团队</strong>
              <p>加入团队或重连协作服务后，这里会汇总跨团队任务与审核待办。</p>
            </div>
          ) : error && !data ? (
            <div className="inbox-empty-block is-error" role="alert">
              <strong>无法读取收件箱</strong>
              <p>{error}</p>
              <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={props.onRefresh}>
                重试
              </button>
            </div>
          ) : (
            <>
              {error && <p className="inbox-inline-error" role="alert">{error}</p>}
              {loading && !data ? (
                <div className="inbox-empty-block" role="status">
                  <p>正在汇总跨团队待办…</p>
                </div>
              ) : cloudItems.length === 0 ? (
                <div className="inbox-empty-block" role="status">
                  <IconCheck size={22} aria-hidden="true" />
                  <strong>当前列表为空</strong>
                  <p>
                    {bucket === "action_required"
                      ? "没有需要你接收或验收的跨团队任务。"
                      : bucket === "sent"
                        ? "你发起的任务目前均已处理，或筛选条件下暂无条目。"
                        : "最近 30 天内暂无已处理任务。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="inbox-review-layout review-layout">
                    <div
                      className="inbox-side k-side"
                      role="listbox"
                      aria-label="跨团队待办列表"
                      onKeyDown={handleListKeyDown}
                    >
                      {cloudItems.map(item => {
                        const actorName = resolveActorName(item.actorId)
                        const wsName = workspacesById.get(item.workspaceId) ?? "团队"
                        const active = item.itemKey === effectiveSelectedKey
                        return (
                          <button
                            key={item.itemKey}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`inbox-row k-row${active ? " is-active" : ""}`}
                            onClick={() => setSelectedKey(item.itemKey)}
                          >
                            <span className="inbox-row-title">{item.title}</span>
                            <span className="inbox-row-meta">
                              <span
                                className="hui-badge"
                                data-tone={badgeToneForCategory(item.category, item.urgency)}
                                data-size="xs"
                              >
                                {formatInboxCategoryLabel(item.category)}
                              </span>
                              <span
                                className="hui-badge"
                                data-tone={badgeToneForTaskStatus(item.status)}
                                data-size="xs"
                              >
                                {formatInboxTaskStatusLabel(item.status)}
                              </span>
                              {item.delegated && (
                                <span className="hui-badge" data-tone="accent" data-size="xs">代管</span>
                              )}
                              <span>{actorName}</span>
                              <span aria-hidden="true">·</span>
                              <span className="inbox-row-loc">{item.projectName || wsName}</span>
                              <span aria-hidden="true">·</span>
                              <span>{formatRelativeTime(item.updatedAtMs)}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    {renderDetailPane()}
                  </div>
                  {data?.truncated && (
                    <p className="inbox-truncated-note" role="status">
                      当前最多展示前 {cloudItems.length} 条最新待办，可通过团队或类别筛选缩小范围。
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
