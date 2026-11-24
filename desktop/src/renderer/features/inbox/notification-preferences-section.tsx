/**
 * 【功能定义】系统设置弹窗「通知与提醒」分组：
 * 管理外部企业自研 IM 轻通知开关、订阅事件类型、跨午夜免打扰时段与合批延迟窗口，严格使用 `expectedVersion` 乐观锁保存。
 */
import { useCallback, useEffect, useState } from "react"
import type {
  ExternalNotificationEventType,
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
} from "@workbench/collaboration-client/types"
import type { InboxHost } from "../../../shared/index.js"
import {
  EXTERNAL_EVENT_OPTIONS,
  MERGE_WINDOW_OPTIONS,
  formatDndWindow,
  minutesToTimeString,
  timeStringToMinutes,
} from "./inbox-model.js"

export type NotificationPreferencesSectionProps = {
  readonly host?: InboxHost
  readonly signedIn: boolean
  readonly isOffline: boolean
  readonly open: boolean
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"
  } catch {
    return "Asia/Shanghai"
  }
}

export function NotificationPreferencesSection({
  host,
  signedIn,
  isOffline,
  open,
}: NotificationPreferencesSectionProps) {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null)
  const [externalEnabled, setExternalEnabled] = useState(true)
  const [subscribedEvents, setSubscribedEvents] = useState<ExternalNotificationEventType[]>([
    "task.assigned",
    "task.review_requested",
    "task.returned",
  ])
  const [dndEnabled, setDndEnabled] = useState(false)
  const [dndStartText, setDndStartText] = useState("22:00")
  const [dndEndText, setDndEndText] = useState("09:00")
  const [dndTimezone, setDndTimezone] = useState(defaultTimezone)
  const [mergeWindowSec, setMergeWindowSec] = useState(60)

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")

  const applyServerPreferences = useCallback((value: NotificationPreferences) => {
    setPrefs(value)
    setExternalEnabled(value.externalEnabled)
    setSubscribedEvents([...value.subscribedEvents])
    setDndEnabled(value.dndEnabled)
    setDndStartText(minutesToTimeString(value.dndStartMinute))
    setDndEndText(minutesToTimeString(value.dndEndMinute))
    setDndTimezone(value.dndTimezone || defaultTimezone())
    setMergeWindowSec(value.mergeWindowSec)
  }, [])

  const loadPreferences = useCallback(async () => {
    if (!host || !signedIn || isOffline) return
    setLoading(true)
    setError("")
    try {
      const res = await host.getNotificationPreferences()
      if (!res.ok) {
        setError(res.error.message)
        return
      }
      applyServerPreferences(res.value)
    } catch {
      setError("无法读取通知偏好设置，请重试。")
    } finally {
      setLoading(false)
    }
  }, [host, signedIn, isOffline, applyServerPreferences])

  useEffect(() => {
    if (open && signedIn && !isOffline) {
      setNotice("")
      void loadPreferences()
    }
  }, [open, signedIn, isOffline, loadPreferences])

  if (!signedIn) return null

  if (!host) {
    return (
      <section className="desktop-notif-prefs" aria-label="通知与提醒">
        <p className="desktop-set-help">通知偏好通道尚未就绪。</p>
      </section>
    )
  }

  if (isOffline) {
    return (
      <section className="desktop-notif-prefs" aria-label="通知与提醒">
        <p className="desktop-set-help" role="status">
          当前处于离线续用状态，重连协作服务后可查看并调整外部 IM 轻通知与免打扰设置。
        </p>
      </section>
    )
  }

  const startMinute = timeStringToMinutes(dndStartText)
  const endMinute = timeStringToMinutes(dndEndText)
  const dirty = Boolean(
    prefs
    && (
      prefs.externalEnabled !== externalEnabled
      || prefs.dndEnabled !== dndEnabled
      || startMinute !== prefs.dndStartMinute
      || endMinute !== prefs.dndEndMinute
      || prefs.mergeWindowSec !== mergeWindowSec
      || prefs.subscribedEvents.length !== subscribedEvents.length
      || prefs.subscribedEvents.some(ev => !subscribedEvents.includes(ev))
    ),
  )

  const toggleEvent = (eventType: ExternalNotificationEventType, checked: boolean) => {
    setNotice("")
    setError("")
    setSubscribedEvents(prev => {
      if (checked) return prev.includes(eventType) ? prev : [...prev, eventType]
      return prev.filter(item => item !== eventType)
    })
  }

  const handleSave = async () => {
    if (!prefs || saving) return
    if (startMinute === null || endMinute === null) {
      setError("免打扰开始或结束时间格式无效，请使用 HH:mm（例如 22:00）。")
      return
    }
    setSaving(true)
    setError("")
    setNotice("")
    const payload: NotificationPreferencesUpdateRequest = {
      externalEnabled,
      subscribedEvents,
      dndEnabled,
      dndStartMinute: startMinute,
      dndEndMinute: endMinute,
      dndTimezone: dndTimezone || defaultTimezone(),
      mergeWindowSec,
      expectedVersion: prefs.version,
    }
    try {
      const res = await host.updateNotificationPreferences(payload)
      if (res.ok) {
        applyServerPreferences(res.value)
        setNotice("通知设置已保存。")
        return
      }
      if (res.error.code === "VERSION_CONFLICT") {
        setError("配置已在其他终端更新，已为你刷新最新配置。")
        await loadPreferences()
        return
      }
      setError(res.error.message)
    } catch {
      setError("保存通知设置失败，请重试。")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="desktop-notif-prefs" aria-label="通知与提醒">
      {loading && !prefs ? (
        <p className="desktop-set-help" role="status">正在读取通知设置…</p>
      ) : (
        <>
          <div className="desktop-set-row">
            <div className="desktop-set-main">
              <label className="desktop-set-label" htmlFor="notif-external-enabled">外部 IM 轻通知</label>
              <span className="desktop-set-help">
                仅发送事件类型、任务标题、发起人、项目与安全跳转链接，绝不上传或转发会话正文、代码或 Diff。
              </span>
            </div>
            <input
              id="notif-external-enabled"
              type="checkbox"
              checked={externalEnabled}
              disabled={saving || !prefs}
              onChange={event => {
                setNotice("")
                setError("")
                setExternalEnabled(event.target.checked)
              }}
            />
          </div>

          <div className="desktop-set-row desktop-notif-events-row">
            <div className="desktop-set-main">
              <span className="desktop-set-label">触发提醒的事件类型</span>
              <span className="desktop-set-help">关闭对应勾选后，该类事件仍会显示在工作台收件箱，但不再推送到外部 IM。</span>
            </div>
            <div className="desktop-notif-checks">
              {EXTERNAL_EVENT_OPTIONS.map(opt => {
                const checked = subscribedEvents.includes(opt.id)
                return (
                  <label key={opt.id} className="desktop-notif-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving || !prefs || !externalEnabled}
                      onChange={event => toggleEvent(opt.id, event.target.checked)}
                    />
                    <span className="desktop-notif-check-text">
                      <strong>{opt.label}</strong>
                      <small>{opt.help}</small>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="desktop-set-row desktop-notif-dnd-row">
            <div className="desktop-set-main">
              <label className="desktop-set-label" htmlFor="notif-dnd-enabled">免打扰时段</label>
              <span className="desktop-set-help">
                命中免打扰时暂缓外发并在结束时刻补发；支持跨午夜（当前时区：{dndTimezone}）。
              </span>
            </div>
            <input
              id="notif-dnd-enabled"
              type="checkbox"
              checked={dndEnabled}
              disabled={saving || !prefs}
              onChange={event => {
                setNotice("")
                setError("")
                setDndEnabled(event.target.checked)
              }}
            />
            {dndEnabled && (
              <div className="desktop-notif-dnd-times">
                <label>
                  <span>开始</span>
                  <input
                    type="time"
                    aria-label="免打扰开始时间"
                    value={dndStartText}
                    disabled={saving || !prefs}
                    onChange={event => {
                      setNotice("")
                      setError("")
                      setDndStartText(event.target.value)
                    }}
                  />
                </label>
                <span aria-hidden="true">~</span>
                <label>
                  <span>结束</span>
                  <input
                    type="time"
                    aria-label="免打扰结束时间"
                    value={dndEndText}
                    disabled={saving || !prefs}
                    onChange={event => {
                      setNotice("")
                      setError("")
                      setDndEndText(event.target.value)
                    }}
                  />
                </label>
                {startMinute !== null && endMinute !== null && (
                  <span className="desktop-notif-dnd-preview">{formatDndWindow(startMinute, endMinute)}</span>
                )}
              </div>
            )}
          </div>

          <div className="desktop-set-row">
            <div className="desktop-set-main">
              <label className="desktop-set-label" htmlFor="notif-merge-window">同项目连续变更合并窗口</label>
              <span className="desktop-set-help">在窗口内自动合批同类通知；若你在窗口期内已读或已办，将自动取消外发。</span>
            </div>
            <select
              id="notif-merge-window"
              aria-label="同项目连续变更合并窗口"
              value={String(mergeWindowSec)}
              disabled={saving || !prefs || !externalEnabled}
              onChange={event => {
                setNotice("")
                setError("")
                setMergeWindowSec(Number(event.target.value))
              }}
            >
              {MERGE_WINDOW_OPTIONS.map(opt => (
                <option key={opt.value} value={String(opt.value)}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="desktop-notif-actions">
            <button
              type="button"
              className="wb-button wb-button-primary wb-button-small"
              disabled={!prefs || saving || !dirty}
              onClick={() => { void handleSave() }}
            >
              {saving ? "保存中…" : "保存通知设置"}
            </button>
            <button
              type="button"
              className="wb-button wb-button-secondary wb-button-small"
              disabled={loading || saving}
              onClick={() => {
                setNotice("")
                void loadPreferences()
              }}
            >
              重新加载
            </button>
            {notice && <span className="desktop-notif-saved" role="status">{notice}</span>}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </section>
  )
}
