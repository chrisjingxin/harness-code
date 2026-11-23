/**
 * 「停止共享」二次确认弹窗（对齐方案 B 原型）：
 * 明确提示已上传内容会保留为团队只读快照、无法收回，而本机原始会话与团队上下文完整保留。
 */
import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import { IconX } from "@tabler/icons-react"

export type StopSharingDialogProps = {
  readonly title: string
  readonly projectName: string | null
  readonly onClose: () => void
  readonly onConfirmStop: () => Promise<string | null>
}

export function StopSharingDialog({
  title,
  projectName,
  onClose,
  onConfirmStop,
}: StopSharingDialogProps): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { returnTo?.focus() }
  }, [])

  async function submit() {
    if (busy) return
    setBusy(true)
    setError("")
    const err = await onConfirmStop().catch(() => "停止共享失败，请重试。")
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}
      onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose() } }}
    >
      <form
        className="dlg pnav-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlgStopShareTitle"
        noValidate
        onSubmit={event => { event.preventDefault(); void submit() }}
      >
        <div className="dlg-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h2 id="dlgStopShareTitle">停止共享</h2>
            <p className="dlg-sub">{title || "未命名会话"}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            disabled={busy}
            style={{ marginLeft: "auto" }}
            onClick={onClose}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="dlg-body">
          <p className="psess-dlg-lead">
            停止向{projectName ? `「${projectName}」` : " Project "}共享后，本机后续新对话不再上传，但已被团队成员同步或留在项目中的内容无法收回，将继续保持只读可见。
          </p>
          <p className="help">此会话仍完整保存在本机「个人」空间，已有团队上下文不变，可以继续本地对话。</p>
          {error && <p className="err" role="alert">{error}</p>}
        </div>

        <div className="dlg-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "正在停止…" : "确认停止共享"}
          </button>
        </div>
      </form>
    </div>
  )
}
