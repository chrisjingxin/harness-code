/**
 * Runner 正式入口：默认启动唯一设备连接；--self-test 只验证本机账本与单实例锁。
 * stdout 只输出结构化结果，诊断走 stderr。
 */
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Ledger, OwnerLock, type LocalDeviceRegistration } from "@workbench/runner-core"
import { configFromEnv, startRunner } from "./runtime.js"

async function selfTest(directory: string, holdMs: number): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = OwnerLock.acquire(join(directory, "owner.sqlite"))
  const ledger = Ledger.open(join(directory, "runner.sqlite"))
  try {
    const probe = ledger.probe()
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, node: process.versions.node,
      processType: (process as NodeJS.Process & { type?: string }).type ?? null, ...probe }) + "\n")
    if (holdMs > 0) await new Promise<void>(done => setTimeout(done, Math.min(holdMs, 15_000)))
  } finally {
    ledger.close()
    lock.release()
  }
}

interface StoreRequest {
  type: "device-store"
  requestId: string
  action: "load" | "save"
  origin: string
  device?: LocalDeviceRegistration
}
const parentPort = (process as NodeJS.Process & {
  parentPort?: { postMessage(message: object): void; on(event: "message", listener: (message: { data: StoreRequest | { type: "stop" } }) => void): void }
}).parentPort

/** 私有通道只提供设备记录的具名动作，不接受 SQL、任意文件读写或来自页面的路径。 */
function respond(request: StoreRequest, work: () => LocalDeviceRegistration | null | void) {
  try {
    if (!["load", "save"].includes(request.action) || new URL(request.origin).origin !== request.origin
      || (request.action === "save" && request.device?.origin !== request.origin)) throw new Error("LEDGER_MISMATCH")
    parentPort?.postMessage({ type: "device-store-result", requestId: request.requestId, ok: true, value: work() ?? null })
  } catch {
    parentPort?.postMessage({ type: "device-store-result", requestId: request.requestId, ok: false })
  }
}

const args = process.argv.slice(2)
if (args[0] === "--device-store") {
  const directory = args[1]
  if (!directory || !parentPort) process.exit(2)
  parentPort.on("message", ({ data }) => {
    if (data.type !== "device-store") return
    respond(data, () => {
      const path = join(directory, "runner.sqlite")
      if (!existsSync(path) && data.action === "load") return null
      const lock = OwnerLock.acquire(join(directory, "owner.sqlite"))
      try {
        const ledger = Ledger.open(path)
        try {
          if (data.action === "save") ledger.saveLocalDevice(data.device!)
          return ledger.localDevice(data.origin)
        } finally { ledger.close() }
      } finally { lock.release() }
    })
    setTimeout(() => process.exit(0), 10)
  })
} else if (args[0] === "--initialize-ledger") {
  const [directory, ledgerId] = args.slice(1)
  try {
    if (!directory || !ledgerId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ledgerId)) throw new Error("LEDGER_MISMATCH")
    const lock = OwnerLock.acquire(join(directory, "owner.sqlite"))
    try {
      const ledger = Ledger.open(join(directory, "runner.sqlite"))
      try { ledger.requireIdentity(ledgerId, true); ledger.probe() }
      finally { ledger.close() }
    } finally { lock.release() }
    process.exit(0)
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: "runner.initialize.failed", code: (error as Error).message }) + "\n")
    process.exit(1)
  }
} else if (args[0] === "--self-test") {
  const directory = args[1]
  if (!directory) { process.stderr.write("需要隔离目录\n"); process.exit(2) }
  const hold = Number(args[2] ?? "0")
  try {
    await selfTest(directory, Number.isFinite(hold) ? hold : 0)
    process.exit(0)
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: (error as Error).message }) + "\n")
    process.exit(1)
  }
} else {
  try {
    const runner = startRunner(configFromEnv(process.env), undefined, state => parentPort?.postMessage({ type: "state", state }))
    process.stderr.write(JSON.stringify({ event: "runner.started", pid: process.pid }) + "\n")
    let stopping = false
    const shutdown = async (signal: string) => {
      if (stopping) return
      stopping = true
      process.stderr.write(JSON.stringify({ event: "runner.stopping", signal }) + "\n")
      try { await runner.stop(); process.exit(0) }
      catch { process.exit(1) }
    }
    parentPort?.on("message", ({ data }) => {
      if (data.type === "stop") void shutdown("host")
      if (data.type === "device-store" && !stopping) respond(data, () => {
        if (data.action === "save") runner.saveLocalDevice(data.device!)
        return runner.localDevice(data.origin)
      })
    })
    process.once("SIGINT", () => void shutdown("SIGINT"))
    process.once("SIGTERM", () => void shutdown("SIGTERM"))
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: "runner.failed", code: (error as Error).message }) + "\n")
    process.exit(1)
  }
}
