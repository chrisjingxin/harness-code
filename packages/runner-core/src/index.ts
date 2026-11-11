/** runner-core 的独立包标识与已实现公共入口。 */
export const packageId = "@workbench/runner-core" as const

export { Ledger } from "./ledger.js"
export type { ExecutionRecord, LocalState, OutboxItem } from "./ledger.js"
export type { LocalDeviceRegistration } from "@workbench/contracts"
export { OwnerLock } from "./owner-lock.js"
export { ProjectRegistry, rootRef } from "./project-registry.js"
export { CommandHandler, UnavailableExecutionPort } from "./command-handler.js"
export type { ExecutionPort } from "./command-handler.js"
export { DeviceConnection } from "./device-connection.js"
export type { DeviceConnectionOptions } from "./device-connection.js"
export * from "./execution-codec.js"
