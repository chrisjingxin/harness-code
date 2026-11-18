/** 严格映射本机执行端口到固定 IPC，渲染进程拿不到 Electron 事件或通信对象。 */
import type { IpcRenderer } from "electron"
import type { DesktopLocalExecutionHost, LocalExecutionNotice } from "../local-execution-host.js"

export function createLocalExecutionHost(ipc: IpcRenderer): DesktopLocalExecutionHost {
  return {
    prepare: (scope, directory) => ipc.invoke("workbench:local-execution:prepare", scope, directory),
    send: (scope, bindingId, requestId, text, referenceIds = []) =>
      ipc.invoke("workbench:local-execution:send", scope, bindingId, requestId, text, referenceIds),
    cancel: (scope, bindingId, turnId) => ipc.invoke("workbench:local-execution:cancel", scope, bindingId, turnId),
    answerPermission: (scope, bindingId, turnId, requestId, optionId) =>
      ipc.invoke("workbench:local-execution:answer-permission", scope, bindingId, turnId, requestId, optionId),
    onNotice: listener => {
      const receive = (_event: unknown, notice: LocalExecutionNotice) => listener(notice)
      ipc.on("workbench:local-execution:notice", receive)
      return () => { ipc.removeListener("workbench:local-execution:notice", receive) }
    },
  }
}
