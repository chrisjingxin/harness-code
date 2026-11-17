/** 用 HC-217/218 的实际外壳和会话协调器核对 HC-219 页面切换。固定业务资料只在这个入口注入。 */
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { DesktopWorkbench } from "../../../../apps/desktop/src/renderer/desktop-workbench.js"
import { PersonalPersistence } from "../../../../apps/desktop/src/renderer/personal-persistence.js"
import { createCollaborationPageProviders } from "../../../../apps/desktop/src/renderer/features/collaboration/collaboration-pages.js"
import type { ProjectTaskDetails } from "../../../../apps/desktop/src/renderer/features/collaboration/tasks/project-tasks.js"
import type { KnowledgeActions, KnowledgeVersionContent } from "../../../../apps/desktop/src/renderer/features/collaboration/knowledge/team-knowledge.js"
import { snapshotReferenceView } from "../../../../apps/desktop/src/renderer/features/collaboration/references/conversation-references.js"
import { ProjectWorkbench, useProjectShell } from "../../../../apps/desktop/src/renderer/features/project-navigation/index.js"
import { createSessionPageProvider, useProjectSessions } from "../../../../apps/desktop/src/renderer/features/session/index.js"
import { colleague, device, hosts, members, project, referenceHosts, user, workspace } from "./fixture-hosts.js"
import "@workbench/ui/theme.css"
import "@workbench/ui/project.css"

const task: ProjectTaskDetails = {
  id: "TASK-021", title: "核对支付回调处理顺序", publisher: { id: colleague.id, name: colleague.userName },
  assignee: { id: user.id, name: user.userName }, statusLabel: "待处理",
  description: "补充超时查询和重复回调的处理示例。", materials: [],
}
const taskDetails = new Map([[task.id, task]])
const knowledgeItem = { id: "idempotency", title: "接口幂等规约" }
const version: KnowledgeVersionContent = {
  itemId: knowledgeItem.id, versionId: "idempotency-v2", versionLabel: "v2", author: colleague.userName,
  updatedAt: "2026-11-14 10:30",
  referenceAvailability: { enabled: false, reason: "本人会话引用入口待接入。" },
  reference: snapshotReferenceView({
    id: "idempotency-v2", title: knowledgeItem.title, owner: colleague.userName,
    version: "v2", uploadedAt: "2026-11-14 10:30", rangeLabel: "固定版本",
    text: "## 支付回调\n\n同一业务请求在重试时沿用原请求号。",
  }),
}
const knowledgeActions: KnowledgeActions = {
  async readCurrent(_scope, itemId) {
    return itemId === knowledgeItem.id
      ? { status: "ready", value: version }
      : { status: "unavailable", message: "示例条目不可用。" }
  },
}

function Preview() {
  const [notice, setNotice] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [persistence] = useState(() => new PersonalPersistence(hosts.personalHost, setNotice))
  const shell = useProjectShell({
    organization: hosts.organization, collaboration: hosts.collaboration, persistence,
    workspaceId: workspace.id, user, namespace: "hc219-workbench-preview",
  })
  const sessions = useProjectSessions({
    host: hosts.host, projectConversations: hosts.projectConversations, localDirectory: hosts.localDirectory,
    persistence, scope: shell.scope, projectName: project.name, userId: user.id,
    localDeviceId: device.deviceId, localDeviceName: device.name, members, devices: [device],
    selectedConversationId: shell.personal.page.kind === "conversation" ? shell.personal.page.conversationId : null,
  })
  const scope = shell.scope
  const providers = createCollaborationPageProviders({
    projectName: project.name,
    workspaceName: workspace.name,
    ...(scope ? {
      tasks: { scope, tasks: [task], details: taskDetails },
      knowledge: { scope, items: { status: "ready", value: [knowledgeItem] }, actions: knowledgeActions },
    } : {}),
  })

  return <ProjectWorkbench
    shell={shell} organization={hosts.organization} persistence={persistence}
    workspaceId={workspace.id} workspaceName={workspace.name} user={user} titleBarClassName="desktop-titlebar"
    settings={<h2>HC-219 工作台装配预览</h2>} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
    personalError={notice} sessions={sessions.navigationSource} providers={{ session: createSessionPageProvider(sessions.pageController), ...providers }}
  />
}

const mode = new URLSearchParams(window.location.search).get("mode")
if (mode === "references") {
  document.documentElement.dataset.hc219SnapshotReads = "0"
  document.documentElement.dataset.hc219SendCalls = "0"
}
createRoot(document.getElementById("root")!).render(
  mode === "references" ? <DesktopWorkbench {...referenceHosts} />
    : mode === "unavailable" ? <DesktopWorkbench {...hosts} />
    : <Preview />,
)
