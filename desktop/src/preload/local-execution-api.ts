/** 严格映射本机执行端口到固定 IPC，渲染进程拿不到 Electron 事件或通信对象。 */
import type { IpcRenderer } from "electron"
import type { DesktopLocalExecutionHost, LocalExecutionNotice } from "../shared/index.js"

export function createLocalExecutionHost(ipc: IpcRenderer): DesktopLocalExecutionHost {
  return {
    listProviders: () => ipc.invoke("workbench:local-execution:list-providers"),
    promptQueue: (scope, action) => ipc.invoke("workbench:local-execution:prompt-queue", scope, action),
    prepare: (scope, directory, providerId) =>
      providerId === undefined
        ? ipc.invoke("workbench:local-execution:prepare", scope, directory)
        : ipc.invoke("workbench:local-execution:prepare", scope, directory, providerId),
    confirmDirectory: scope => ipc.invoke("workbench:local-execution:confirm-directory", scope),
    stageImage: (scope, input) => ipc.invoke("workbench:local-execution:stage-image", scope, input),
    readImage: (scope, imageId) => ipc.invoke("workbench:local-execution:read-image", scope, imageId),
    removeStagedImage: (scope, imageId) => ipc.invoke("workbench:local-execution:remove-staged-image", scope, imageId),
    send: (scope, bindingId, requestId, text, referenceIds = [], attachments = [], images = []) =>
      images.length > 0
        ? ipc.invoke("workbench:local-execution:send", scope, bindingId, requestId, text, referenceIds, attachments, images)
        : attachments.length === 0
          ? ipc.invoke("workbench:local-execution:send", scope, bindingId, requestId, text, referenceIds)
          : ipc.invoke("workbench:local-execution:send", scope, bindingId, requestId, text, referenceIds, attachments),
    steer: (scope, bindingId, turnId, input) =>
      ipc.invoke("workbench:local-execution:steer", scope, bindingId, turnId, input),
    cancel: (scope, bindingId, turnId) => ipc.invoke("workbench:local-execution:cancel", scope, bindingId, turnId),
    answerPermission: (scope, bindingId, turnId, requestId, optionId) =>
      ipc.invoke("workbench:local-execution:answer-permission", scope, bindingId, turnId, requestId, optionId),
    setMode: (scope, bindingId, modeId) =>
      ipc.invoke("workbench:local-execution:set-mode", scope, bindingId, modeId),
    setConfigOption: (scope, bindingId, configId, value) =>
      ipc.invoke("workbench:local-execution:set-config-option", scope, bindingId, configId, value),
    answerElicitation: (scope, bindingId, requestId, answer) =>
      ipc.invoke("workbench:local-execution:answer-elicitation", scope, bindingId, requestId, answer),
    codeCheckpoint: (scope, action) => ipc.invoke("workbench:local-execution:code-checkpoint", scope, action),
    onNotice: listener => {
      const receive = (_event: unknown, notice: LocalExecutionNotice) => listener(notice)
      ipc.on("workbench:local-execution:notice", receive)
      return () => { ipc.removeListener("workbench:local-execution:notice", receive) }
    },
  }
}
