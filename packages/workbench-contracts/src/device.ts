/** 设备登记/共享 HTTP 与设备通道控制帧；执行正文只引用 execution 唯一源。 */
import type { Uuid, Sequence, ShareVersion, UtcTimestamp } from "./conversation.js"
import type { CollaborationResult } from "./identity.js"
import type {
  ExecutionStartMessage, ExecutionCancelMessage, ExecutionStartDecisionMessage, ExecutionEventsAckMessage,
  ExecutionRunnerMessage, ExecutionProblem, RecoveryLocalState, ExecutionTerminalMessage, ExecutionCancelMessage as CancelMessage,
} from "./execution.js"

export type ConnectionState = "offline" | "reconciling" | "ready"

export interface AgentConfigSummary { agentConfigId: Uuid; name: string; available: boolean }
export interface DeviceSummary {
  deviceId: Uuid
  workspaceId: Uuid
  ownerUserId: Uuid
  name: string
  createdAt: UtcTimestamp
  revokedAt: UtcTimestamp | null
  connectionState: ConnectionState
  lastSeenAt: UtcTimestamp | null
}
export interface ProjectSummary {
  projectId: Uuid
  deviceId: Uuid
  workspaceId: Uuid
  name: string
  shareEnabled: boolean
  shareVersion: ShareVersion
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
  agentConfigs: AgentConfigSummary[]
}
export interface DeviceRegistrationRequest {
  registrationId: Uuid
  deviceId: Uuid
  installationId: Uuid
  ledgerId: Uuid
  name: string
  secret: string
}
export interface DeviceRegistrationResponse { registrationId: Uuid; device: DeviceSummary }
export interface DevicePageCursor { beforeCreatedAt: UtcTimestamp; beforeDeviceId: Uuid }
export interface DeviceListResponse { workspaceId: Uuid; devices: DeviceSummary[]; nextPage: DevicePageCursor | null }
export interface DeviceRevokeRequest { requestId: Uuid }
export interface DeviceRevokedResponse { deviceId: Uuid; revokedAt: UtcTimestamp }
export interface ProjectPageCursor { beforeCreatedAt: UtcTimestamp; beforeProjectId: Uuid }
export interface ProjectListResponse { workspaceId: Uuid; deviceId: Uuid; projects: ProjectSummary[]; nextPage: ProjectPageCursor | null }
export interface ProjectStopSharingRequest { requestId: Uuid; expectedShareVersion: ShareVersion }
export interface DeviceProjectPublishRequest {
  requestId: Uuid
  projectId: Uuid
  name: string
  shareEnabled: boolean
  expectedShareVersion: ShareVersion
  agentConfigs: AgentConfigSummary[]
}
export interface ProjectSavedResponse { requestId: Uuid; project: ProjectSummary }

/** 仅 main 与私有 Runner 端口使用的本机登记记录，禁止投影到 renderer 或云端。 */
export interface LocalDeviceRegistration {
  origin: string
  deviceId: Uuid
  installationId: Uuid
  ledgerId: Uuid
  registrationId: Uuid
  registered: boolean
  ownerUserId: Uuid
  secret: string
  workspaceId: Uuid
  projectId: Uuid
  projectRoot: string
  projectName: string
  shareEnabled: boolean
  shareVersion: ShareVersion
  pendingPublishId: Uuid | null
}

interface ControlHeader<T extends string> { protocolVersion: 1; messageId: Uuid; type: T; occurredAt: UtcTimestamp }

export interface DeviceWelcomePayload {
  deviceId: Uuid
  workspaceId: Uuid
  ownerUserId: Uuid
  ledgerId: Uuid
  resumeId: Uuid
  heartbeatIntervalMs: 15000
  heartbeatTimeoutMs: 45000
}
export interface DeviceWelcomeMessage extends ControlHeader<"device.welcome"> { payload: DeviceWelcomePayload }

export interface ResumeInventoryRequestPayload { resumeId: Uuid; kind: "inventory"; afterStartCommandId: Uuid | null }
export interface ResumeLookupRequestPayload { resumeId: Uuid; kind: "lookup"; startCommandId: Uuid }
export interface DeviceResumeRequestMessage extends ControlHeader<"device.resume.request"> {
  payload: ResumeInventoryRequestPayload | ResumeLookupRequestPayload
}

export interface LocalExecutionRecord {
  kind: "execution"
  start: ExecutionStartMessage
  decision: ExecutionStartDecisionMessage | null
  cancel: CancelMessage | null
  localState: Exclude<RecoveryLocalState, "notFound">
  lastRunnerSequence: string
  lastCommittedRunnerSequence: string
  nativeSessionId: string | null
  terminal: ExecutionTerminalMessage | null
}
export interface CancelBeforeStartRecord {
  kind: "cancelBeforeStart"
  cancel: CancelMessage
  lastRunnerSequence: string
  lastCommittedRunnerSequence: string
  terminal: ExecutionTerminalMessage
}
export type ResumeRecord = LocalExecutionRecord | CancelBeforeStartRecord

export interface DeviceResumeMessage extends ControlHeader<"device.resume"> {
  payload: {
    resumeId: Uuid
    requestMessageId: Uuid
    ledgerId: Uuid
    afterStartCommandId: Uuid | null
    records: ResumeRecord[]
    nextAfterStartCommandId: Uuid | null
  }
}

export interface DeviceCommandStatusFoundPayload {
  resumeId: Uuid
  requestMessageId: Uuid
  ledgerId: Uuid
  startCommandId: Uuid
  result: "found"
  record: ResumeRecord
}
export interface DeviceCommandStatusNotFoundPayload {
  resumeId: Uuid
  requestMessageId: Uuid
  ledgerId: Uuid
  startCommandId: Uuid
  result: "notFound"
}
export interface DeviceCommandStatusMessage extends ControlHeader<"device.command.status"> {
  payload: DeviceCommandStatusFoundPayload | DeviceCommandStatusNotFoundPayload
}

export interface DeviceProjectChangedMessage extends ControlHeader<"device.project.changed"> {
  payload: { resumeId: Uuid | null; projectId: Uuid; shareEnabled: boolean; shareVersion: ShareVersion }
}
export interface DeviceProjectSavedMessage extends ControlHeader<"device.project.saved"> {
  payload: { resumeId: Uuid | null; requestMessageId: Uuid; projectId: Uuid; shareVersion: ShareVersion; result: "applied" | "notRegistered" }
}
export interface DeviceReadyMessage extends ControlHeader<"device.ready"> { payload: { resumeId: Uuid; ledgerId: Uuid } }
export interface DeviceExecutionProblemMessage extends ControlHeader<"device.execution.problem"> { payload: ExecutionProblem }
export type DeviceProblemCode =
  | "INVALID_CONTROL_FRAME" | "LEDGER_MISMATCH" | "RESUME_TIMEOUT" | "COMMAND_CONFLICT" | "LOCAL_STORE_FULL" | "LOCAL_STORE_UNAVAILABLE"
export interface DeviceProblemMessage extends ControlHeader<"device.problem"> {
  payload: { resumeId: Uuid | null; requestMessageId: Uuid | null; code: DeviceProblemCode; message: string }
}
export type DeviceControlMessage =
  | DeviceWelcomeMessage
  | DeviceResumeRequestMessage
  | DeviceResumeMessage
  | DeviceCommandStatusMessage
  | DeviceProjectChangedMessage
  | DeviceProjectSavedMessage
  | DeviceReadyMessage
  | DeviceExecutionProblemMessage
  | DeviceProblemMessage
export type DeviceMessage =
  | DeviceControlMessage
  | ExecutionStartMessage
  | CancelMessage
  | ExecutionStartDecisionMessage
  | ExecutionEventsAckMessage
export interface DeviceEnvelope { connectionId: Uuid; message: DeviceMessage }
export interface DeviceBatchEnvelope { connectionId: Uuid; messages: ExecutionRunnerMessage[] }

/** 桌面宿主对本机设备的最小状态；不包含秘密、路径或通用网络入口。 */
export interface DeviceState {
  status: "idle" | "registered" | "running" | "stopped" | "unavailable"
  deviceId: Uuid | null
  projectId: Uuid | null
  connection: ConnectionState
  shareEnabled?: boolean
  message?: string
}

/** 具名设备端口：renderer 只能选择目录/登记/共享/停止，不能传入任意路径或请求。 */
export interface DeviceHost {
  getState(): Promise<CollaborationResult<DeviceState>>
  listDevices(workspaceId: Uuid): Promise<CollaborationResult<DeviceListResponse>>
  registerDevice(workspaceId: Uuid, name: string): Promise<CollaborationResult<DeviceState>>
  listProjects(workspaceId: Uuid, deviceId: Uuid): Promise<CollaborationResult<ProjectListResponse>>
  revokeDevice(workspaceId: Uuid, deviceId: Uuid, requestId: Uuid): Promise<CollaborationResult<DeviceRevokedResponse>>
  stopSharing(workspaceId: Uuid, projectId: Uuid, requestId: Uuid, expectedShareVersion: ShareVersion): Promise<CollaborationResult<ProjectSavedResponse>>
  shareProject(): Promise<CollaborationResult<DeviceState>>
  startRunner(): Promise<CollaborationResult<DeviceState>>
  stopRunner(): Promise<CollaborationResult<DeviceState>>
  onStateChanged(listener: (state: DeviceState) => void): () => void
}
