/**
 * 【功能定义】1200px 居中「管理与设置」主工作区（HC-255 停点 2）：
 * 按左侧 AdminSidebar 选中的 5 个真实设置分区，分别在宽屏居中 .page-shell 内组织展示：
 * 外观/密度/快捷键、外部 IM 通知偏好、本机项目记忆（严格按活跃团队会话作用域挂载）、账号身份与团队成员交接。
 * 不虚构任何未接后端的占位选项。
 */
import { IconRefresh } from "@tabler/icons-react"
import type { AcpAgentInfo } from "@workbench/acp-runtime/types"
import type { CollaborationHost, WorkspaceSummary } from "@workbench/collaboration-client/types"
import type { ReactElement, ReactNode } from "react"
import type { InboxHost, LocalExecutionScope, OrganizationHost } from "../../../shared/index.js"
import { IdentityPanel, type useCollaborationIdentity } from "../../../ui/index.js"
import { NotificationPreferencesSection } from "../inbox/index.js"
import { AgentPreflightCard } from "../personal-sessions/agent-preflight-card.js"
import { ProjectMemory } from "../workbench-context/project-memory.js"
import { TeamSettings } from "../workspace/team-settings.js"
import { ADMIN_SECTION_META, type AdminSectionId } from "./admin-model.js"
import "./admin.css"

type IdentityState = ReturnType<typeof useCollaborationIdentity>

export type AdminPageProps = {
  readonly activeSection: AdminSectionId
  readonly appearanceContent: ReactNode
  readonly providers?: readonly AcpAgentInfo[]
  readonly checkingProviders?: boolean
  readonly onRefreshProviders?: () => void
  readonly inboxHost?: InboxHost
  readonly collaboration: CollaborationHost
  readonly organization: OrganizationHost
  readonly identity: IdentityState
  readonly workspace: WorkspaceSummary | null
  readonly userId: string
  readonly isOffline: boolean
  readonly memoryScope: LocalExecutionScope | null
  readonly memoryWorkspaceName: string | null
  readonly onReconnect: () => void
  readonly onBackToWorkbench: () => void
  readonly onSelectSection: (section: AdminSectionId) => void
}

export function AdminPage({
  activeSection,
  appearanceContent,
  providers,
  checkingProviders = false,
  onRefreshProviders,
  inboxHost,
  collaboration,
  organization,
  identity,
  workspace,
  userId,
  isOffline,
  memoryScope,
  memoryWorkspaceName,
  onReconnect,
  onBackToWorkbench,
  onSelectSection,
}: AdminPageProps): ReactElement {
  const meta = ADMIN_SECTION_META[activeSection]
  const availableProviders = (providers ?? []).filter(item => item.available)

  let body: ReactNode = null

  if (activeSection === "appearance") {
    body = (
      <>
        <div className="panel admin-panel">
          <div className="panel-head">
            <h2>外观与窗口比例</h2>
            <span className="hui-badge" data-tone="muted" data-size="xs">本机持久化</span>
          </div>
          {appearanceContent}
        </div>

        <div className="panel admin-panel">
          <div className="panel-head">
            <h2>快捷键一览</h2>
            <span className="hui-badge" data-tone="muted" data-size="xs">桌面工作台</span>
          </div>
          <div className="kbd-grid" aria-label="快捷键一览">
            <div className="kbd-item"><span>命令面板</span><span className="kbd-combo"><kbd>⌘</kbd><kbd>K</kbd></span></div>
            <div className="kbd-item"><span>收起 / 展开次级侧栏</span><span className="kbd-combo"><kbd>⌘</kbd><kbd>\</kbd></span></div>
            <div className="kbd-item"><span>发送消息</span><span className="kbd-combo"><kbd>Enter</kbd></span></div>
            <div className="kbd-item"><span>关闭弹窗 / 浮层</span><span className="kbd-combo"><kbd>Esc</kbd></span></div>
          </div>
        </div>
      </>
    )
  } else if (activeSection === "agents") {
    body = (
      <div className="panel admin-panel">
        <div className="panel-head">
          <h2>本机 ACP Agent 探测状态</h2>
          <span
            className="hui-badge"
            data-tone={providers === undefined ? "muted" : availableProviders.length > 0 ? "success" : "warn"}
            data-size="xs"
          >
            {providers === undefined ? "检测中" : availableProviders.length > 0 ? "就绪" : "待配置"}
          </span>
        </div>
        <p className="admin-panel-desc">
          默认自动探测本机 Harness Code；如需切换或调试自定义 ACP Agent，可在启动环境配置 <code>WORKBENCH_ACP_EXECUTABLE</code> 与 <code>WORKBENCH_ACP_ARGS_JSON</code> 后点击「重新检测」。
        </p>
        <AgentPreflightCard
          mode="panel"
          providers={providers}
          checking={checkingProviders}
          onRefresh={onRefreshProviders ?? (() => {})}
        />
      </div>
    )
  } else if (activeSection === "notifications") {
    body = (
      <div className="panel admin-panel">
        <div className="panel-head">
          <h2>外部 IM 轻通知与免打扰</h2>
          <span className="hui-badge" data-tone={isOffline ? "warn" : "info"} data-size="xs">
            {isOffline ? "离线只读" : "服务端同步"}
          </span>
        </div>
        <NotificationPreferencesSection
          host={inboxHost}
          signedIn
          isOffline={isOffline}
          open
        />
      </div>
    )
  } else if (activeSection === "memory") {
    const contextBridge = typeof window !== "undefined" ? window.workbenchContext : undefined
    body = memoryScope && contextBridge ? (
      <div className="panel admin-panel admin-memory-host">
        <div className="panel-head">
          <h2>当前团队的本机项目记忆</h2>
          <span className="hui-badge" data-tone="accent" data-size="xs">
            {memoryWorkspaceName || "团队作用域"}
          </span>
        </div>
        <p className="admin-panel-desc">
          两份 Markdown 由当前 Agent 或本人维护，仅保存在本机，适用于此会话所属团队。
        </p>
        <ProjectMemory scope={memoryScope} host={contextBridge} />
      </div>
    ) : (
      <div className="panel admin-panel">
        <div className="panel-head">
          <h2>尚未选定团队会话作用域</h2>
          <span className="hui-badge" data-tone="muted" data-size="xs">
            {isOffline ? "离线" : workspace ? "未激活团队会话" : "未入团"}
          </span>
        </div>
        <p className="admin-panel-desc" role="status">
          本机项目记忆按账号和团队隔离，通过本人会话核对访问资格。
          {isOffline
            ? "当前处于离线状态，重连协作服务并打开任意团队会话后即可在此管理。"
            : !workspace
              ? "当前账号尚未加入团队；个人空间会话直接使用各自绑定的本机工作目录。"
              : "请先进入「工作台 → 团队」打开或新建一条项目协作会话，再回来维护对应的本机项目记忆。"}
        </p>
        <div className="admin-empty-actions">
          {isOffline && (
            <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={onReconnect}>
              <IconRefresh size={14} aria-hidden="true" />
              <span>重连服务</span>
            </button>
          )}
          <button type="button" className="wb-button wb-button-primary wb-button-small" onClick={onBackToWorkbench}>
            返回工作台
          </button>
        </div>
      </div>
    )
  } else if (activeSection === "account") {
    body = (
      <div className="panel admin-panel">
        <div className="panel-head">
          <h2>当前身份与服务端连接</h2>
          <span className="hui-badge" data-tone={isOffline ? "warn" : "success"} data-size="xs">
            {isOffline ? "离线续用" : "已连接"}
          </span>
        </div>
        <IdentityPanel host={collaboration} identity={identity} workspaceId={workspace?.id ?? null} />
      </div>
    )
  } else {
    body = !isOffline && workspace ? (
      <TeamSettings
        host={collaboration}
        organization={organization}
        workspace={workspace}
        accountId={userId}
      />
    ) : (
      <div className="panel admin-panel">
        <div className="panel-head">
          <h2>团队成员与仓库</h2>
          <span className="hui-badge" data-tone={isOffline ? "warn" : "muted"} data-size="xs">
            {isOffline ? "离线" : "未入团"}
          </span>
        </div>
        <p className="admin-panel-desc" role="status">
          {isOffline
            ? "协作服务暂不可达，重连后可查看团队成员角色、办理离职交接或登记团队仓库。"
            : "当前账号尚未加入任何协作空间。个人对话可正常使用，或前往「账号与登录」确认组织归属。"}
        </p>
        <div className="admin-empty-actions">
          {isOffline ? (
            <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={onReconnect}>
              <IconRefresh size={14} aria-hidden="true" />
              <span>重连服务</span>
            </button>
          ) : (
            <button type="button" className="wb-button wb-button-soft wb-button-small" onClick={() => onSelectSection("account")}>
              查看账号与登录
            </button>
          )}
          <button type="button" className="wb-button wb-button-primary wb-button-small" onClick={onBackToWorkbench}>
            返回工作台
          </button>
        </div>
      </div>
    )
  }

  return (
    <section className="admin-stage" aria-label={`管理与设置 · ${meta.title}`}>
      <div className="page-shell">
        <div className="page-head">
          <div>
            <h1 className="sr">{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
        </div>
        {body}
      </div>
    </section>
  )
}
