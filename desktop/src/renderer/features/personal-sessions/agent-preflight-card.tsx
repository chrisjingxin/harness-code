/**
 * 本机 ACP Agent 冷启动连通性预检卡片。
 *
 * 【功能定义】在新建个人会话或无可用本机 Agent 时展示各探测源的连通状态、失败原因、
 * 「重新检测」按钮与「打开设置」入口，避免用户无提示地卡在发送不可用态。
 */
import type { ReactElement } from "react"
import { IconAlertTriangle, IconCheck, IconRefresh, IconSettings } from "@tabler/icons-react"
import type { AcpAgentInfo } from "@workbench/acp-runtime/types"

export type AgentPreflightCardProps = {
  readonly providers: readonly AcpAgentInfo[] | undefined
  readonly checking: boolean
  readonly onRefresh: () => void
  readonly onOpenSettings?: () => void
}

export function AgentPreflightCard({
  providers,
  checking,
  onRefresh,
  onOpenSettings,
}: AgentPreflightCardProps): ReactElement {
  const list = providers ?? []
  const available = list.filter(item => item.available)

  if (providers === undefined) {
    return (
      <div className="psess-preflight is-loading" role="status">
        <span className="psess-preflight-dot" aria-hidden="true" />
        <span>正在检测本机 Agent 可用性…</span>
      </div>
    )
  }

  if (available.length > 0) {
    return (
      <div className="psess-preflight is-ready" role="status">
        <IconCheck size={14} aria-hidden="true" />
        <span>
          本机 Agent 已就绪（可用：{available.map(item => item.label).join("、")}）
        </span>
        <button
          type="button"
          className="psess-preflight-retry"
          disabled={checking}
          onClick={onRefresh}
        >
          <IconRefresh size={12} aria-hidden="true" />
          <span>{checking ? "检测中…" : "重新检测"}</span>
        </button>
      </div>
    )
  }

  return (
    <section className="psess-preflight is-blocked" aria-label="本机 Agent 连通性预检">
      <div className="psess-preflight-head">
        <IconAlertTriangle size={16} aria-hidden="true" />
        <div className="psess-preflight-title">
          <strong>未检测到可用的本机 Agent</strong>
          <p>请确认已安装 Harness Code / 兼容 ACP Agent 或设置 `WORKBENCH_ACP_EXECUTABLE`，你仍可先创建会话与管理目录。</p>
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
            <span>打开设置</span>
          </button>
        )}
      </div>
    </section>
  )
}
