/** 左下统一设置入口与真实连接状态；设置窗口独立于右侧文件和变更。 */
/** @jsxImportSource react */

import { Settings2, Terminal } from "lucide-react"

import type { WebAdapterSnapshot, WebIntent } from "../../application/adapter"

/** 直接打开上次设置分类，不经过重复菜单。 */
export function WorkspaceTools({ snapshot, dispatch, disabled }: {
  snapshot: WebAdapterSnapshot
  dispatch: (intent: WebIntent) => void
  disabled: boolean
}): React.ReactElement {
  const { runtime, connection, git } = snapshot.interactive
  const workspace = runtime.executionMode === "local" ? "本地工作区" : "远端沙箱"
  const connectionLabel = connection.status !== "open" ? "未连接"
    : git.busy ? "已连接 · Git 操作中" : disabled ? "只读" : "已连接"

  return (
    <div className="workspace-tools">
      <button type="button" className="workspace-tool-button" disabled={disabled} data-settings-trigger
        aria-label="设置与工具" aria-haspopup="dialog" aria-expanded={snapshot.settings.open}
        onClick={() => dispatch({ type: "settings-open" })}>
        <Settings2 size={16} aria-hidden="true" />设置与工具
      </button>
      <div className="workspace-connection">
        <Terminal size={14} aria-hidden="true" />
        <span>{workspace} · {connectionLabel}</span>
      </div>
    </div>
  )
}
