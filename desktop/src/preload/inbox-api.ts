/**
 * 【功能定义】严格映射跨团队收件箱与用户级通知端口到固定 IPC，渲染进程拿不到 Electron 事件或通信对象。
 * 【协作边界】仅在 Preload 隔离环境调用，依赖 `../shared/index.js` 的纯类型与通道常量。
 */
import type { IpcRenderer } from "electron"
import type { UserUpdatesNotice } from "@workbench/collaboration-client/types"
import { inboxChannels as channels, type InboxHost } from "../shared/index.js"

export function createInboxHost(ipc: IpcRenderer): InboxHost {
  return {
    getInbox: query => query === undefined ? ipc.invoke(channels.getInbox) : ipc.invoke(channels.getInbox, query),
    listUserNotifications: query =>
      query === undefined ? ipc.invoke(channels.listNotifications) : ipc.invoke(channels.listNotifications, query),
    getNotificationPreferences: () => ipc.invoke(channels.getPreferences),
    updateNotificationPreferences: input => ipc.invoke(channels.updatePreferences, input),
    subscribe: (subscriptionId, initialCursor) =>
      initialCursor === undefined
        ? ipc.invoke(channels.subscribe, subscriptionId)
        : ipc.invoke(channels.subscribe, subscriptionId, initialCursor),
    acknowledge: (subscriptionId, id) => ipc.invoke(channels.acknowledge, subscriptionId, id),
    unsubscribe: subscriptionId => ipc.invoke(channels.unsubscribe, subscriptionId),
    onNotice: listener => {
      const receive = (_event: unknown, notice: UserUpdatesNotice) => listener(notice)
      ipc.on(channels.notice, receive)
      return () => { ipc.removeListener(channels.notice, receive) }
    },
  }
}
