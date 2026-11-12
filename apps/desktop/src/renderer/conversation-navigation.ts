/** 会话按真实设备/项目 ID 分组；名称缺失时保留原目标标识。 */
import type { ConversationSummary, DeviceSummary, ProjectSummary } from "@workbench/contracts"
import type { NavigationAvailability, NavigationConversation, NavigationDevice, NavigationProject } from "@workbench/ui"

type ProjectPage = { rows: readonly ProjectSummary[]; availability: NavigationAvailability }
type ProjectRow = Omit<NavigationProject, "conversations"> & { conversations: NavigationConversation[] }
type DeviceRow = Omit<NavigationDevice, "projects"> & { projects: ProjectRow[] }

export function conversationNavigation(input: {
  devices: readonly DeviceSummary[]
  projects: Partial<Record<string, ProjectPage>>
  conversations: readonly ConversationSummary[]
  availability: NavigationAvailability
  expandedDevices: readonly string[]
  expandedProjects: readonly string[]
}): NavigationDevice[] {
  const devices: DeviceRow[] = input.devices.map(device => ({
    id: device.deviceId,
    name: device.name,
    connection: device.revokedAt ? "已撤销" : device.connectionState === "ready" ? "在线" : device.connectionState === "reconciling" ? "恢复中" : "离线",
    expanded: input.expandedDevices.includes(device.deviceId),
    availability: input.projects[device.deviceId]?.availability ?? { state: "unavailable", message: "展开设备以读取项目。" },
    projects: (input.projects[device.deviceId]?.rows ?? []).map(project => ({
      id: project.projectId,
      name: project.name,
      expanded: input.expandedProjects.includes(JSON.stringify([device.deviceId, project.projectId])),
      availability: input.availability,
      conversations: [],
    })),
  }))
  const byId = new Map(devices.map(device => [device.id, device]))
  for (const conversation of input.conversations) {
    let device = byId.get(conversation.deviceId)
    if (!device) {
      device = {
        id: conversation.deviceId,
        name: `设备 ${conversation.deviceId}`,
        connection: "状态未确认",
        expanded: input.expandedDevices.includes(conversation.deviceId),
        availability: { state: "ready" },
        projects: [],
      }
      devices.push(device)
      byId.set(device.id, device)
    }
    let project = device.projects.find(item => item.id === conversation.projectId)
    if (!project) {
      project = {
        id: conversation.projectId,
        name: `项目 ${conversation.projectId}`,
        expanded: input.expandedProjects.includes(JSON.stringify([conversation.deviceId, conversation.projectId])),
        availability: input.availability,
        conversations: [],
      }
      device.projects.push(project)
    }
    project.conversations.push({
      id: conversation.conversationId,
      title: conversation.title,
      deviceId: conversation.deviceId,
      projectId: conversation.projectId,
    })
  }
  for (const device of devices) {
    if (device.availability.state === "denied" && device.projects.some(project => project.conversations.length)) {
      device.availability = { state: "unavailable", message: device.availability.message }
    }
  }
  return devices
}
