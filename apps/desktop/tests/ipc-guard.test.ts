/**
 * `ipc-guard.ts` 单元测试：
 * 覆盖通用基础校验器、可信来源与参数数量断言、严格抛错型与安全包装型 IPC 注册器，以及统一注销清理。
 */
import assert from "node:assert/strict"
import { register } from "node:module"
import { test } from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"

if (!("bun" in process.versions)) {
  const resolveTsHook = `
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    export async function resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const jsUrl = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(jsUrl))) {
          const tsSpecifier = specifier.slice(0, -3) + ".ts";
          const tsUrl = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsSpecifier, context);
        }
      }
      return nextResolve(specifier, context);
    }
  `
  register(`data:text/javascript,${encodeURIComponent(resolveTsHook)}`)
}

const guard = await import("../src/main/ipc-guard.ts")

const VALID_UUID = "aaaaaaaa-1111-4111-8111-111111111111"
const VALID_USER_ID = "abcdef0123456789abcdef0123456789"
const TRUSTED_URL = "file:///app/index.html"

function createFakeWindow(options: { destroyed?: boolean; url?: string } = {}) {
  const mainFrame = { url: options.url ?? TRUSTED_URL }
  const webContents = { mainFrame }
  const window = {
    isDestroyed: () => Boolean(options.destroyed),
    webContents,
  } as unknown as BrowserWindow
  const validEvent = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  return { window, webContents, mainFrame, validEvent }
}

function createFakeIpc() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const removed: string[] = []
  return {
    ipc: {
      handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
        handlers.set(channel, listener)
      },
      removeHandler(channel: string) {
        removed.push(channel)
        handlers.delete(channel)
      },
    },
    handlers,
    removed,
  }
}

test("基础参数校验器准确拦截非法 UUID、用户 ID、空字符串与非普通对象", () => {
  assert.equal(guard.isUuid(VALID_UUID), true)
  assert.equal(guard.isUuid("not-a-uuid"), false)
  assert.equal(guard.isUuid(VALID_UUID.toUpperCase()), false)
  assert.equal(guard.areUuids(VALID_UUID, "22222222-2222-4222-8222-222222222222"), true)
  assert.equal(guard.areUuids(VALID_UUID, "bad"), false)

  assert.equal(guard.isUserId(VALID_USER_ID), true)
  assert.equal(guard.isUserId("short"), false)
  assert.equal(guard.isUserId("11111111-1111-4111-8111-111111111111"), false)

  assert.equal(guard.isNonEmptyString("hello"), true)
  assert.equal(guard.isNonEmptyString("   "), false)
  assert.equal(guard.isNonEmptyString("abcd", 3), false)
  assert.equal(guard.isNonEmptyString(123), false)

  assert.equal(guard.isPlainObject({ a: 1 }), true)
  assert.equal(guard.isPlainObject(null), false)
  assert.equal(guard.isPlainObject([]), false)
  assert.equal(guard.isPlainObject("str"), false)

  assert.equal(guard.isNonNegativeSafeInteger(0), true)
  assert.equal(guard.isNonNegativeSafeInteger(-1), false)
  assert.equal(guard.isPositiveSafeInteger(1), true)
  assert.equal(guard.isPositiveSafeInteger(0), false)
})

test("assertDesktopRequest 校验可信来源与精确参数数量", () => {
  const { window, validEvent, webContents } = createFakeWindow()
  assert.doesNotThrow(() => guard.assertDesktopRequest(window, TRUSTED_URL, validEvent, ["a"], 1))

  assert.throws(() => guard.assertDesktopRequest(window, TRUSTED_URL, validEvent, [], 1))

  const badUrlEvent = { sender: webContents, senderFrame: { url: "https://evil.invalid/" } } as unknown as IpcMainInvokeEvent
  assert.throws(() => guard.assertDesktopRequest(window, TRUSTED_URL, badUrlEvent, ["a"], 1))

  const destroyed = createFakeWindow({ destroyed: true })
  assert.throws(() => guard.assertDesktopRequest(destroyed.window, TRUSTED_URL, destroyed.validEvent, [], 0))
})

test("createStrictIpcRegistrar 在来源或参数错误时抛错并在 dispose 时注销全部通道", async () => {
  const { window, validEvent, webContents } = createFakeWindow()
  const { ipc, handlers, removed } = createFakeIpc()
  const registrar = guard.createStrictIpcRegistrar({ window, trustedUrl: TRUSTED_URL, ipc })

  registrar.handle("desktop:ping", 1, value => ({ pong: value }))
  const handler = handlers.get("desktop:ping")!
  assert.deepEqual(await handler(validEvent, "ok"), { pong: "ok" })
  assert.throws(() => handler(validEvent))

  const badEvent = { sender: webContents, senderFrame: { url: "https://other.invalid" } } as unknown as IpcMainInvokeEvent
  assert.throws(() => handler(badEvent, "ok"))

  registrar.dispose()
  assert.deepEqual(removed, ["desktop:ping"])
  assert.equal(handlers.size, 0)
})

test("createCollaborationIpcRegistrar 返回统一 CollaborationError 并支持自定义原始错误壳", async () => {
  const { window, validEvent, webContents } = createFakeWindow()
  const { ipc, handlers, removed } = createFakeIpc()
  let invoked = false
  const registrar = guard.createCollaborationIpcRegistrar({ window, trustedUrl: TRUSTED_URL, ipc })

  registrar.handle("collab:echo", 1, value => {
    invoked = true
    return { ok: true, value }
  })
  registrar.handle("collab:boom", 0, () => {
    throw new Error("boom")
  })
  registrar.handleRaw("personal:load", 1, key => ({ ok: true, value: { key } }), () => ({ ok: false, message: "读取失败" }))

  const echo = handlers.get("collab:echo")!
  const badEvent = { sender: webContents, senderFrame: { url: "https://evil.invalid" } } as unknown as IpcMainInvokeEvent
  const rejected = await echo(badEvent, "x") as { ok: false; error: { code: string } }
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, "REQUEST_SOURCE_REJECTED")
  assert.equal(invoked, false)

  const badCount = await echo(validEvent) as { ok: false; error: { code: string } }
  assert.equal(badCount.ok, false)
  assert.equal(badCount.error.code, "INVALID_REQUEST")
  assert.equal(invoked, false)

  const okRes = await echo(validEvent, "hello") as { ok: true; value: string }
  assert.deepEqual(okRes, { ok: true, value: "hello" })

  const boomRes = await handlers.get("collab:boom")!(validEvent) as { ok: false; error: { code: string } }
  assert.equal(boomRes.ok, false)
  assert.equal(boomRes.error.code, "INTERNAL_ERROR")

  const rawFail = await handlers.get("personal:load")!(badEvent, { kind: "account" })
  assert.deepEqual(rawFail, { ok: false, message: "读取失败" })

  registrar.dispose()
  assert.deepEqual(removed, ["collab:echo", "collab:boom", "personal:load"])
})
