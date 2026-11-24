/**
 * 本机 ACP Agent 连通性预检组件：
 * - `mode="banner"`（首页）：正常探测中或已有可用 Agent 时完全静默不打扰；仅全部不可用时显示异常引导与快捷跳转；
 * - `mode="panel"`（管理与设置 → 本机 Agent）：完整展示全部 Provider 探测状态、不可用原因与「重新检测」入口。
 */
import type { ReactElement } from "react"
import { IconAlertTriangle, IconRefresh, IconSettings } from "@tabler/icons-react"
import type { AcpAgentInfo } from "@workbench/acp-runtime/types"

export type AgentPreflightCardProps = {
  readonly mode?: "banner" | "panel"
  readonly providers: readonly AcpAgentInfo[] | undefined
  readonly checking: boolean
  readonly onRefresh: () => void
  readonly onOpenSettings?: () => void
}

export function AgentPreflightCard({
  mode = "banner",
  providers,
  checking,
  onRefresh,
  onOpenSettings,
}: AgentPreflightCardProps): ReactElement | null {
  const list = providers ?? []
  const available = list.filter(item => item.available)

  if (mode === "panel") {
    return (
      <div className="psess-provider-panel">
        <div className="psess-provider-toolbar">
          <span className="psess-provider-summary">
            {providers === undefined
              ? "正在检测本机可用的 ACP Agent…"
              : available.length > 0
                ? `已就绪 ${available.length} / ${list.length} 个本机 Agent`
                : "暂未检测到可用的本机 Agent"}
          </span>
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small"
            disabled={checking}
            onClick={onRefresh}
          >
            <IconRefresh size={13} aria-hidden="true" />
            <span>{checking ? "正在检测…" : "重新检测"}</span>
          </button>
        </div>

        {providers !== undefined && list.length > 0 && (
          <ul className="psess-provider-list" aria-label="本机 Agent 列表">
            {list.map(item => (
              <li key={item.id} className="psess-provider-row">
                <div className="psess-provider-main">
                  <div className="psess-provider-title">
                    <strong>{item.label}</strong>
                    <span className="hui-badge mono" data-tone="muted" data-size="xs">{item.id}</span>
                  </div>
                  {!item.available && (
                    <p className="psess-provider-reason">{item.reason || "当前不可用，请检查可执行程序与环境配置。"}</p>
                  )}
                </div>
                <span
                  className="hui-badge"
                  data-tone={item.available ? "success" : "warn"}
                  data-size="xs"
                >
                  <span className="hui-lamp" aria-hidden="true" />
                  <span>{item.available ? "可用" : "不可用"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {providers !== undefined && list.length === 0 && (
          <p className="psess-provider-empty" role="status">
            当前未发现已注册的本机 Agent 驱动。
          </p>
        )}
      </div>
    )
  }

  // 首页 banner 模式：探测中或已就绪时静默隐藏，只在真正无可用 Agent 时提示排查。
  if (providers === undefined || available.length > 0) {
    return null
  }

  return (
    <section className="psess-preflight is-blocked" aria-label="本机 Agent 连通性预检">
      <div className="psess-preflight-head">
        <IconAlertTriangle size={16} aria-hidden="true" />
        <div className="psess-preflight-title">
          <strong>未检测到可用的本机 Agent</strong>
          <p>请确认已安装 Harness Code / 兼容 ACP Agent 或检查配置，你仍可先创建会话与管理目录。</p>
        </div>
      </div>

      {list.length > 0 && (
        <ul className="psess-preflight-list">
          {list.map(item => (
            <li key={item.id}>
              <span className="psess-preflight-name">{item.label}</span>
              <span className="psess-preflight-reason">{item.reason || "暂不可用"}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="psess-preflight-actions">
        <button
          type="button"
          className="wb-button wb-button-secondary wb-button-small"
          disabled={checking}
          onClick={onRefresh}
        >
          <IconRefresh size={13} aria-hidden="true" />
          <span>{checking ? "正在检测…" : "重新检测"}</span>
        </button>
        {onOpenSettings && (
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small"
            onClick={onOpenSettings}
          >
            <IconSettings size={13} aria-hidden="true" />
            <span>本机 Agent 设置</span>
          </button>
        )}
      </div>
    </section>
  )
}
