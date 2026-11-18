/**
 * 【功能定义】桌面主进程统一 IPC 守卫与基础参数校验器：
 * 收拢窗口来源验证（复用 `verifyDesktopSource`）、参数个数断言、统一错误序列化封装以及常见标识/字符串/对象校验。
 *
 * 【协作边界】
 * - 供 `desktop-ipc.ts`、`collaboration-ipc.ts`、`organization-ipc.ts` 与 `project-updates-ipc.ts` 共用，避免各 IPC 模块重复编写校验模板。
 * - 支持在单元测试中注入模拟 `ipcMain`，不在模块顶层解构运行时 `electron.ipcMain`。
 */
import electron, { type BrowserWindow, type IpcMainInvokeEvent } from "electron"
import type { CollaborationError } from "@workbench/contracts"
import { identityError } from "./collaboration-state.js"
import { verifyDesktopSource } from "./trusted-source.js"

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const USER_ID_PATTERN = /^[0-9a-f]{32}$/

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value)
export const areUuids = (...values: unknown[]): boolean => values.every(isUuid)
export const isNullableUuid = (value: unknown): value is string | null => value === null || isUuid(value)
export const isUserId = (value: unknown): value is string => typeof value === "string" && USER_ID_PATTERN.test(value)

export const isNonEmptyString = (value: unknown, maxLength = 4096): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maxLength

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1

/** 统一构造可跨进程序列化的业务错误结果。 */
export function formatIpcError(code: CollaborationError["code"], message: string): { ok: false; error: CollaborationError } {
  return identityError(code, message)
}

/** 校验请求是否来自受信任的同源主窗口主框架，且参数个数与声明严格一致。 */
export function assertDesktopRequest(
  window: BrowserWindow,
  trustedUrl: string,
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
  expectedCount: number,
  argErrorMessage = "桌面请求参数无效",
): void {
  verifyDesktopSource(window, trustedUrl, event)
  if (args.length !== expectedCount) throw new Error(argErrorMessage)
}

function resolveIpcMain(ipc?: IpcMainLike): IpcMainLike {
  return ipc ?? electron.ipcMain
}

/**
 * 创建严格抛错型 IPC 注册器（用于 `DesktopHost` 等原生桌面接口）：
 * 来源校验或参数数量不符时直接抛出异常令渲染端 Promise 拒绝，并在 `dispose()` 时注销全部通道。
 */
export function createStrictIpcRegistrar(options: {
  window: BrowserWindow
  trustedUrl: string
  ipc?: IpcMainLike
  argErrorMessage?: string
}) {
  const target = resolveIpcMain(options.ipc)
  const channels: string[] = []
  return {
    handle(channel: string, count: number, action: (...args: unknown[]) => unknown): void {
      channels.push(channel)
      target.handle(channel, (event, ...args: unknown[]) => {
        assertDesktopRequest(options.window, options.trustedUrl, event, args, count, options.argErrorMessage)
        return action(...args)
      })
    },
    dispose(): void {
      for (const channel of channels) target.removeHandler(channel)
      channels.length = 0
    },
  }
}

/**
 * 创建协作安全封装型 IPC 注册器（用于协作、组织、看板与个人存储通道）：
 * 拦截非受信来源、错误参数数量和未捕获异常，转换为统一 `CollaborationError` 或自定义安全返回壳。
 */
export function createCollaborationIpcRegistrar(options: {
  window: BrowserWindow
  trustedUrl: string
  ipc?: IpcMainLike
  messages?: {
    sourceRejected?: string
    invalidRequest?: string
    internalError?: string
  }
}) {
  const target = resolveIpcMain(options.ipc)
  const channels: string[] = []
  const sourceRejected = options.messages?.sourceRejected ?? "不允许的请求来源。"
  const invalidRequest = options.messages?.invalidRequest ?? "请求参数无效。"
  const internalError = options.messages?.internalError ?? "操作暂时无法完成。"

  return {
    handle(channel: string, count: number, action: (...args: unknown[]) => unknown): void {
      channels.push(channel)
      target.handle(channel, async (event, ...args: unknown[]) => {
        try {
          verifyDesktopSource(options.window, options.trustedUrl, event)
        } catch {
          return formatIpcError("REQUEST_SOURCE_REJECTED", sourceRejected)
        }
        if (args.length !== count) {
          return formatIpcError("INVALID_REQUEST", invalidRequest)
        }
        try {
          return await action(...args)
        } catch {
          return formatIpcError("INTERNAL_ERROR", internalError)
        }
      })
    },
    handleRaw(
      channel: string,
      count: number,
      action: (...args: unknown[]) => unknown,
      onError: () => unknown,
    ): void {
      channels.push(channel)
      target.handle(channel, async (event, ...args: unknown[]) => {
        try {
          assertDesktopRequest(options.window, options.trustedUrl, event, args, count)
          return await action(...args)
        } catch {
          return onError()
        }
      })
    },
    dispose(): void {
      for (const channel of channels) target.removeHandler(channel)
      channels.length = 0
    },
  }
}
