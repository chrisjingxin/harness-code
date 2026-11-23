/**
 * 【功能定义】桌面身份、项目会话、协作应用与个人视图 IPC 装配入口：
 * 统一经 `ipc-guard.ts` 校验来源与参数数量 → 强类型参数/请求体守卫 → 窗口工作区守卫 → 不含凭据的安全结果。
 *
 * 【协作边界】
 * - 保留 `bindLocalExecutionIpc` 装配接点供独立本机 ACP 执行桥接使用。
 * - 所有 `CollaborationAppsHost` 通道均由编译期映射表逐项绑定，不再使用绕过类型检查的动态下标强转。
 */
import { app, dialog } from "electron"
import type { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type {
  CollaborationAppsHost,
  ProjectReadAction,
} from "../shared/index.js"
import type {
  CollaborationResult,
  ConversationRegisterRequest,
  ConversationStatus,
  KnowledgeCreateRequest,
  KnowledgeUpdateRequest,
  SnapshotCreateRequest,
  TaskConversationRequest,
  TaskCreateRequest,
  TaskPatchRequest,
  TaskStatus,
  TaskTransitionRequest,
} from "@workbench/collaboration-client/types"
import { CollaborationState, ConversationUploads, type CollaborationClient } from "@workbench/collaboration-client"
import {
  createCollaborationIpcRegistrar,
  formatIpcError,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isNullableUuid,
  isPlainObject,
  isPositiveSafeInteger,
  isUserId,
  isUuid,
} from "./ipc-guard.js"
import { LocalDirectoryService } from "./local-directory-host.js"
import { LocalConversationStore } from "./local-conversation-store.js"
import { bindLocalConversationsIpc } from "./local-conversations-ipc.js"
import { createLocalExecutionCoordinator, type LocalExecutionRuntime } from "./local-execution-coordinator.js"
import { LocalImageStore } from "./local-image-store.js"
import { bindLocalExecutionIpc } from "./local-execution-ipc.js"
import { bindOrganizationIpc } from "./organization-ipc.js"
import { PersonalStore } from "./personal-store.js"
import { bindProjectUpdatesIpc } from "./project-updates-ipc.js"

const CONVERSATION_STATUSES = new Set(["idle", "running", "waiting_approval", "error"])
const TASK_STATUSES = new Set(["todo", "doing", "review", "done", "cancelled"])

const invalidAppRequest = () => Promise.resolve(formatIpcError("INVALID_REQUEST", "请求参数无效。"))

function isProjectReadAction(value: unknown): value is ProjectReadAction {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false
  switch (value.kind) {
    case "listDirectory":
      return typeof value.directory === "string" && (value.cursor === undefined || typeof value.cursor === "string")
    case "searchCandidates":
      return typeof value.directory === "string" && typeof value.query === "string"
        && (value.limit === undefined || isPositiveSafeInteger(value.limit))
    case "readPreview":
      return typeof value.path === "string"
    case "gitStatus":
      return true
    case "gitDiff":
      return typeof value.snapshot === "string" && typeof value.path === "string"
    default:
      return false
  }
}

function isConversationQuery(value: unknown): value is { ownerId?: string; status?: ConversationStatus } | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value) || Object.keys(value).some(key => key !== "ownerId" && key !== "status")) return false
  if (value.ownerId !== undefined && !isUserId(value.ownerId)) return false
  return value.status === undefined || (typeof value.status === "string" && CONVERSATION_STATUSES.has(value.status))
}

function isHistoryLimit(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 500)
}

function isConversationRegisterRequest(value: unknown): value is ConversationRegisterRequest {
  if (!isPlainObject(value) || typeof value.requestId !== "string") return false
  if (value.title !== undefined && typeof value.title !== "string") return false
  if (value.repositoryIds !== undefined
    && (!Array.isArray(value.repositoryIds) || !value.repositoryIds.every(item => typeof item === "string"))) {
    return false
  }
  if (value.conversationId !== undefined && !isUuid(value.conversationId)) return false
  if (value.shareMode !== undefined && value.shareMode !== "full" && value.shareMode !== "summary_only") return false
  if (value.initialBrief !== undefined) {
    if (!isPlainObject(value.initialBrief)) return false
    const brief = value.initialBrief
    if (brief.status !== undefined && (typeof brief.status !== "string" || !CONVERSATION_STATUSES.has(brief.status))) return false
    if (brief.briefSource !== undefined && brief.briefSource !== "rule" && brief.briefSource !== "agent") return false
    if (brief.briefText !== undefined && brief.briefText !== null && typeof brief.briefText !== "string") return false
  }
  return true
}

function isSnapshotRange(value: unknown): value is SnapshotCreateRequest["range"] {
  if (value === undefined) return true
  if (!isPlainObject(value) || typeof value.type !== "string") return false
  switch (value.type) {
    case "latest":
      return value.count === undefined || typeof value.count === "number"
    case "through":
      return typeof value.toSequence === "number"
    case "range":
      return typeof value.fromSequence === "number" && typeof value.toSequence === "number"
    case "brief":
      return true
    default:
      return false
  }
}

function isSnapshotCreateRequest(value: unknown): value is SnapshotCreateRequest {
  return isPlainObject(value) && typeof value.sourceConversationId === "string" && isSnapshotRange(value.range)
}

function isTaskCreateRequest(value: unknown): value is TaskCreateRequest {
  return isPlainObject(value)
    && typeof value.title === "string"
    && typeof value.description === "string"
    && typeof value.assigneeId === "string"
    && typeof value.requestId === "string"
    && (value.snapshotIds === undefined || (Array.isArray(value.snapshotIds) && value.snapshotIds.every(item => typeof item === "string")))
    && (value.knowledgeRefs === undefined || (Array.isArray(value.knowledgeRefs)
      && value.knowledgeRefs.every(ref => isPlainObject(ref) && typeof ref.knowledgeId === "string" && typeof ref.versionId === "string")))
}

function isTaskPatchRequest(value: unknown): value is TaskPatchRequest {
  return isPlainObject(value)
    && typeof value.description === "string"
    && typeof value.expectedVersion === "number"
    && typeof value.requestId === "string"
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.has(value)
}

function isTaskTransitionRequest(value: unknown): value is TaskTransitionRequest {
  return isPlainObject(value)
    && isTaskStatus(value.targetStatus)
    && typeof value.expectedVersion === "number"
    && typeof value.requestId === "string"
    && (value.note === undefined || typeof value.note === "string")
    && (value.commitSha === undefined || typeof value.commitSha === "string")
}

function isTaskConversationRequest(value: unknown): value is TaskConversationRequest {
  return isPlainObject(value)
    && typeof value.conversationId === "string"
    && typeof value.expectedVersion === "number"
    && typeof value.requestId === "string"
}

function isKnowledgeCreateRequest(value: unknown): value is KnowledgeCreateRequest {
  return isPlainObject(value)
    && typeof value.termKey === "string"
    && typeof value.category === "string"
    && typeof value.title === "string"
    && typeof value.text === "string"
}

function isKnowledgeUpdateRequest(value: unknown): value is KnowledgeUpdateRequest {
  return isPlainObject(value)
    && typeof value.category === "string"
    && typeof value.title === "string"
    && typeof value.text === "string"
    && typeof value.expectedVersion === "number"
}

/** 绑定工作台主窗口的协作与本机目录 IPC；窗口关闭时统一释放所有监听和子模块句柄。 */
export function bindCollaborationIpc(
  window: BrowserWindow,
  trustedUrl: string,
  onCloseAborted: () => void,
  runtime: LocalExecutionRuntime,
) {
  const origin = process.env.WORKBENCH_SERVICE_ORIGIN
  const identity = new CollaborationState(origin)
  const client = identity.network()
  const localConversations = new LocalConversationStore(app.getPath("userData"), origin ?? "")
  const personal = new PersonalStore(identity, client ? origin! : "", app.getPath("userData"), localConversations)
  const localDirectory = new LocalDirectoryService(() => identity.personalIdentity()?.accountId ?? null)
  const uploads = client
    ? new ConversationUploads(
        join(app.getPath("userData"), "conversation-uploads"),
        {
          watermark: async (scope, signal) => {
            const detail = await client.getProjectConversation(scope.workspaceId, scope.projectId, scope.conversationId, signal)
            if (!detail.ok) return detail
            if (detail.value.conversation.ownerUserId !== scope.accountId) {
              return formatIpcError("CONVERSATION_FORBIDDEN", "仅会话创建者可执行该操作。")
            }
            if (detail.value.conversation.shareStatus === "stopped") {
              return formatIpcError("CONVERSATION_SHARING_STOPPED", "该会话已停止团队共享。")
            }
            return { ok: true, value: detail.value.conversation.syncedSequence }
          },
          upload: (scope, request, signal) =>
            client.syncConversation(scope.workspaceId, scope.projectId, scope.conversationId, request, signal),
        },
        notice => {
          if (notice.sharingStopped) {
            void localConversations.markSharingStopped(notice.scope.accountId, notice.scope.conversationId).catch(() => {})
          } else if (!notice.failure && notice.syncedSequence !== undefined) {
            void localConversations.updateSyncedSequence(
              notice.scope.accountId,
              notice.scope.conversationId,
              notice.syncedSequence,
            ).catch(() => {})
          }
          if (identity.personalIdentity()?.accountId === notice.scope.accountId && !window.isDestroyed() && !window.webContents.isDestroyed()) {
            try { window.webContents.send("workbench:local-execution:notice", notice) } catch { /* 窗口可能正好关闭。 */ }
          }
        },
      )
    : null
  const localImages = new LocalImageStore(join(app.getPath("userData"), "local-images"))
  const execution = createLocalExecutionCoordinator(window, identity, uploads, runtime, {
    grantsDir: join(app.getPath("userData"), "local-execution-grants"),
    checkpointsDir: join(app.getPath("userData"), "local-checkpoints"),
    images: localImages,
    confirmCheckpointRestore: async path => {
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        message: "确认工作树专用并还原文件？",
        detail: "请确认以下 linked worktree 只供当前会话使用。将应用预览中的文件改动。\n\n" + path,
        buttons: ["取消", "确认还原"],
        defaultId: 0, cancelId: 0, noLink: true,
      })
      return result.response === 1
    },
    origin: origin ?? "",
    personal,
    localConversations,
    onLocalConversationChanged: conversationId => {
      if (identity.personalIdentity() && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try { window.webContents.send("workbench:local-conversations:changed", { conversationId }) } catch { /* 窗口可能正在关闭。 */ }
      }
    },
    confirmDirectoryPrompt: async path => {
      const result = await dialog.showMessageBox(window, {
        type: "question",
        message: "确认此会话的工作目录",
        detail: `允许本机会话在以下目录运行 Agent，并在下次登录时恢复此选择？\n\n${path}`,
        buttons: ["确认目录", "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0
    },
  })
  const unbindExecution = execution ? bindLocalExecutionIpc(window, trustedUrl, execution) : () => {}
  const unbindLocalConversations = bindLocalConversationsIpc(window, trustedUrl, identity, localConversations, uploads)
  const unbindOrganization = bindOrganizationIpc(window, trustedUrl, identity)
  const unbindProjectUpdates = bindProjectUpdatesIpc(window, trustedUrl, identity, origin ?? "")
  const unsubscribe = identity.onStateChanged(state => {
    uploads?.useAccount(state.status === "signedIn" ? state.user.id : null)
    if (!window.isDestroyed()) window.webContents.send("collaboration:state", state)
  })

  const ipc = createCollaborationIpcRegistrar({
    window,
    trustedUrl,
    messages: {
      sourceRejected: "不允许的身份请求来源。",
      invalidRequest: "请求参数无效。",
      internalError: "操作暂时无法完成。",
    },
  })

  ipc.handle("collaboration:get-state", 0, () => identity.getState())
  ipc.handle("collaboration:demo-users", 0, () => identity.listDemoUsers())
  ipc.handle("collaboration:sign-in", 1, userNo => typeof userNo === "string" && /^[0-9a-z][0-9a-z_-]{0,31}$/.test(userNo)
    ? identity.signIn(userNo) : formatIpcError("INVALID_REQUEST", "员工工号无效。"))
  ipc.handle("collaboration:sign-out", 0, () => identity.signOut())
  ipc.handle("collaboration:members", 1, id => isUuid(id) ? identity.listMembers(id) : formatIpcError("INVALID_REQUEST", "工作区标识无效。"))

  // 显式按 CollaborationAppsHost 逐一注册编译期受检处理器，保证方法名、参数个数与返回契约一致。
  function handleApp<K extends keyof CollaborationAppsHost>(
    name: K,
    count: Parameters<CollaborationAppsHost[K]>["length"],
    invoke: (networkClient: CollaborationClient, workspaceId: string, args: readonly unknown[]) => ReturnType<CollaborationAppsHost[K]>,
  ) {
    ipc.handle(`workbench:collaboration-apps:${name}`, count, (workspaceId, ...args) => {
      if (!isUuid(workspaceId)) return formatIpcError("INVALID_REQUEST", "工作区标识无效。")
      return identity.withWorkspace(
        workspaceId,
        (networkClient): Promise<CollaborationResult<unknown>> => invoke(networkClient, workspaceId, args),
        { publishConnectionError: false },
      )
    })
  }

  handleApp("createSnapshot", 3, (c, ws, [projectId, request]) =>
    isUuid(projectId) && isSnapshotCreateRequest(request) ? c.createSnapshot(ws, projectId, request) : invalidAppRequest())
  handleApp("readSnapshot", 3, (c, ws, [projectId, snapshotId]) =>
    isUuid(projectId) && isUuid(snapshotId) ? c.readSnapshot(ws, projectId, snapshotId) : invalidAppRequest())
  handleApp("listTasks", 3, (c, ws, [projectId, afterId]) =>
    isUuid(projectId) && isNullableUuid(afterId) ? c.listTasks(ws, projectId, afterId) : invalidAppRequest())
  handleApp("readTask", 3, (c, ws, [projectId, taskId]) =>
    isUuid(projectId) && isUuid(taskId) ? c.readTask(ws, projectId, taskId) : invalidAppRequest())
  handleApp("createTask", 3, (c, ws, [projectId, request]) =>
    isUuid(projectId) && isTaskCreateRequest(request) ? c.createTask(ws, projectId, request) : invalidAppRequest())
  handleApp("editTask", 4, (c, ws, [projectId, taskId, request]) =>
    isUuid(projectId) && isUuid(taskId) && isTaskPatchRequest(request) ? c.editTask(ws, projectId, taskId, request) : invalidAppRequest())
  handleApp("transitionTask", 4, (c, ws, [projectId, taskId, request]) =>
    isUuid(projectId) && isUuid(taskId) && isTaskTransitionRequest(request) ? c.transitionTask(ws, projectId, taskId, request) : invalidAppRequest())
  handleApp("linkTaskConversation", 4, (c, ws, [projectId, taskId, request]) =>
    isUuid(projectId) && isUuid(taskId) && isTaskConversationRequest(request) ? c.linkTaskConversation(ws, projectId, taskId, request) : invalidAppRequest())
  handleApp("listKnowledge", 3, (c, ws, [query, afterId]) =>
    typeof query === "string" && isNullableUuid(afterId) ? c.listKnowledge(ws, query, afterId) : invalidAppRequest())
  handleApp("readKnowledge", 2, (c, ws, [knowledgeId]) =>
    isUuid(knowledgeId) ? c.readKnowledge(ws, knowledgeId) : invalidAppRequest())
  handleApp("createKnowledge", 2, (c, ws, [request]) =>
    isKnowledgeCreateRequest(request) ? c.createKnowledge(ws, request) : invalidAppRequest())
  handleApp("editKnowledge", 3, (c, ws, [knowledgeId, request]) =>
    isUuid(knowledgeId) && isKnowledgeUpdateRequest(request) ? c.editKnowledge(ws, knowledgeId, request) : invalidAppRequest())
  handleApp("archiveKnowledge", 3, (c, ws, [knowledgeId, expectedVersion]) =>
    isUuid(knowledgeId) && isPositiveSafeInteger(expectedVersion) ? c.archiveKnowledge(ws, knowledgeId, expectedVersion) : invalidAppRequest())
  handleApp("listKnowledgeVersions", 3, (c, ws, [knowledgeId, afterId]) =>
    isUuid(knowledgeId) && isNullableUuid(afterId) ? c.listKnowledgeVersions(ws, knowledgeId, afterId) : invalidAppRequest())
  handleApp("readKnowledgeVersion", 3, (c, ws, [knowledgeId, versionId]) =>
    isUuid(knowledgeId) && isUuid(versionId) ? c.readKnowledgeVersion(ws, knowledgeId, versionId) : invalidAppRequest())

  ipc.handle("workbench:project-conversations:list", 3, (workspaceId, projectId, query) =>
    isUuid(workspaceId) && isUuid(projectId) && isConversationQuery(query)
      ? identity.withWorkspace(workspaceId, c => c.listProjectConversations(workspaceId, projectId, query), { publishConnectionError: false })
      : formatIpcError("INVALID_REQUEST", "项目会话列表参数无效。"))
  ipc.handle("workbench:project-conversations:register", 3, (workspaceId, projectId, request) =>
    isUuid(workspaceId) && isUuid(projectId) && isConversationRegisterRequest(request)
      ? identity.withWorkspace(workspaceId, c => c.registerProjectConversation(workspaceId, projectId, request))
      : formatIpcError("INVALID_REQUEST", "项目会话登记参数无效。"))
  ipc.handle("workbench:project-conversations:get", 3, (workspaceId, projectId, conversationId) =>
    isUuid(workspaceId) && isUuid(projectId) && isUuid(conversationId)
      ? identity.getProjectConversation(workspaceId, projectId, conversationId)
      : formatIpcError("INVALID_REQUEST", "项目会话标识无效。"))
  ipc.handle("workbench:project-conversations:history", 5, (workspaceId, projectId, conversationId, afterSequence, limit) =>
    isUuid(workspaceId) && isUuid(projectId) && isUuid(conversationId)
    && isNonNegativeSafeInteger(afterSequence)
    && isHistoryLimit(limit)
      ? identity.withWorkspace(workspaceId, c => c.readProjectConversationHistory(workspaceId, projectId, conversationId, afterSequence, limit))
      : formatIpcError("INVALID_REQUEST", "项目会话历史参数无效。"))
  ipc.handle("workbench:project-conversations:stop-sharing", 3, (workspaceId, projectId, conversationId) =>
    isUuid(workspaceId) && isUuid(projectId) && isUuid(conversationId)
      ? identity.stopProjectConversationSharing(workspaceId, projectId, conversationId)
      : formatIpcError("INVALID_REQUEST", "停止共享参数无效。"))

  ipc.handle("workbench:local-directory:bind", 4, (workspaceId, projectId, conversationKey, directoryPath) =>
    isNullableUuid(workspaceId) && isNullableUuid(projectId) && (projectId === null || workspaceId !== null)
    && isNonEmptyString(conversationKey, 128) && isNonEmptyString(directoryPath, 4096)
      ? localDirectory.bindDirectory(workspaceId, projectId, conversationKey, directoryPath)
      : formatIpcError("INVALID_REQUEST", "本机工作目录绑定参数无效。"))
  ipc.handle("workbench:local-directory:read", 4, (workspaceId, projectId, conversationKey, action) =>
    isNullableUuid(workspaceId) && isNullableUuid(projectId) && (projectId === null || workspaceId !== null)
    && isNonEmptyString(conversationKey, 128) && isProjectReadAction(action)
      ? localDirectory.readDirectory(workspaceId, projectId, conversationKey, action)
      : formatIpcError("INVALID_REQUEST", "本机工作目录读取参数无效。"))

  ipc.handleRaw("personal:load", 1, key => personal.load(key), () => ({ ok: false, message: "无法读取个人视图。" }))
  ipc.handleRaw("personal:save", 3, (key, revision, value) => personal.save(key, revision, value), () => ({ ok: false, message: "无法保存个人视图。" }))
  ipc.handleRaw("personal:rename-conversation", 2, (key, title) => personal.renameConversation(key, title),
    () => ({ ok: false, message: "无法保存会话标题。" }))

  let allowedToClose = false
  let closeRequest: string | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  const closeFailed = (executionFailed = false) => {
    closeRequest = null
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    onCloseAborted()
    if (!window.isDestroyed()) {
      if (executionFailed) dialog.showErrorBox("本机 Agent 未确认停止", "请稍后再次关闭窗口。")
      else dialog.showErrorBox("个人视图未保存", "请检查应用数据目录，然后再次关闭窗口。")
    }
  }
  window.on("close", event => {
    if (allowedToClose) return
    event.preventDefault()
    if (closeRequest) return
    closeRequest = randomUUID()
    closeTimer = setTimeout(closeFailed, 10000)
    window.webContents.send("personal:prepare-close", closeRequest)
  })
  ipc.handleRaw("personal:close-ready", 2, async (request, ready) => {
    if (typeof request !== "string" || request !== closeRequest || typeof ready !== "boolean") return
    if (!ready) { closeFailed(); return }
    const flushed = await personal.flush()
    // 超时后的旧结果不能取消用户发起的下一次关窗。
    if (request !== closeRequest) return
    if (!flushed) { closeFailed(); return }
    try { await execution.dispose() }
    catch { closeFailed(true); return }
    if (request !== closeRequest) return
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null; closeRequest = null; allowedToClose = true
    if (!window.isDestroyed()) window.close()
  }, () => undefined)

  window.once("closed", () => {
    if (closeTimer) clearTimeout(closeTimer)
    void execution.dispose().catch(() => {})
    unsubscribe()
    unbindExecution()
    unbindLocalConversations()
    unbindOrganization()
    unbindProjectUpdates()
    identity.dispose()
    ipc.dispose()
  })
  return {
    captureDirectorySelection: execution.captureDirectorySelection,
    captureAttachmentSelections: execution.captureAttachmentSelections,
  }
}
