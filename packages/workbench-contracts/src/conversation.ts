/**
 * 跨协议共享的标量标识、时间戳与执行生命周期基础枚举；
 * 供 device.ts、execution.ts、project.ts 与 runner-core 引用。
 * 项目会话契约已统一迁至 organization.ts。
 */
export type Uuid = string
/** 十进制字符串，禁用 Number 承载。 */
export type Sequence = string
export type ShareVersion = string
export type UtcTimestamp = string

export type ExecutionState =
  | "queued"
  | "dispatching"
  | "accepted"
  | "running"
  | "unknown"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rejected"
