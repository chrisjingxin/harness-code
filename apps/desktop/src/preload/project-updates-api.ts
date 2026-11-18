/** 严格映射看板端口到固定 IPC，渲染进程拿不到 Electron 事件或通信对象。 */
import type { IpcRenderer } from "electron"
import { projectUpdatesChannels as channels } from "@workbench/contracts"
import type { ProjectUpdatesHost, ProjectUpdatesNotice } from "@workbench/contracts"

export function createProjectUpdatesHost(ipc: IpcRenderer): ProjectUpdatesHost {
  return {
    readBoard: (workspaceId, projectId) => ipc.invoke(channels.board, workspaceId, projectId),
    subscribe: (workspaceId, subscriptionId) => ipc.invoke(channels.subscribe, workspaceId, subscriptionId),
    acknowledge: (subscriptionId, eventId) => ipc.invoke(channels.acknowledge, subscriptionId, eventId),
    unsubscribe: subscriptionId => ipc.invoke(channels.unsubscribe, subscriptionId),
    onNotice: listener => {
      const receive = (_event: unknown, notice: ProjectUpdatesNotice) => listener(notice)
      ipc.on(channels.notice, receive)
      return () => { ipc.removeListener(channels.notice, receive) }
    },
  }
}
