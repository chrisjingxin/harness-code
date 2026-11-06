/** web-command.ts 用例：注入假桥、假 opener、可控中断源。 */

import { describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runWeb, type WebCommandDeps } from "../../src/web-command"
import type { AcpWebBridge } from "../../src/acp-web/bridge/bridge"

function makeInterrupts() {
  const queue: NodeJS.Signals[] = []
  const waiters: Array<() => void> = []
  return {
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift()
          if (next) yield next
          else await new Promise<void>(resolve => waiters.push(resolve))
        }
      },
    } as AsyncIterable<NodeJS.Signals>,
    fire(signal: NodeJS.Signals) {
      queue.push(signal)
      waiters.splice(0).forEach(resolve => resolve())
    },
  }
}

function fakeBridge(port = 43_210, code = "b".repeat(43)) {
  const stops: Array<{ force?: boolean }> = []
  const created: Array<Record<string, unknown>> = []
  let stopGate: Promise<void> | null = null
  let releaseStop: (() => void) | null = null
  const bridge: AcpWebBridge = {
    start: async () => ({ port, origin: `http://127.0.0.1:${port}` }),
    bootUrl: () => `http://127.0.0.1:${port}/#c=${code}`,
    stop: async (options?: { force?: boolean }) => {
      stops.push(options ?? {})
      if (stopGate) await stopGate
    },
    get connectionCount() { return 0 },
  }
  const createBridge = (options: Record<string, unknown>) => {
    created.push(options)
    return bridge
  }
  return {
    bridge,
    created,
    stops,
    createBridge: createBridge as unknown as WebCommandDeps["createBridge"],
    holdStop() {
      stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    },
    releaseStop() {
      releaseStop?.()
    },
  }
}

function command(overrides: Record<string, unknown> = {}) {
  return { kind: "web" as const, cwd: "/tmp", configPath: undefined, port: undefined, open: true, ...overrides }
}

const LOOKUP_ENV = { HARNESS_AGENT_PYTHON: process.execPath }
const LOOKUP = { moduleDir: process.cwd(), env: LOOKUP_ENV }

describe("runWeb", () => {
  test("启动流程：realpath cwd、默认端口 0、打印提示与地址、开浏览器", async () => {
    const fake = fakeBridge()
    const opened: string[] = []
    const written: string[] = []
    const interrupts = makeInterrupts()
    const promise = runWeb(command(), {
      createBridge: fake.createBridge,
      openBrowser: async url => { opened.push(url) },
      write: line => written.push(line),
      lookup: LOOKUP,
      interrupts: interrupts.iterable,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    expect(await promise).toBe(0)
    expect(fake.created).toHaveLength(1)
    expect((fake.created[0] as { cwd: string }).cwd).toBe(realpathSync("/tmp"))
    expect((fake.created[0] as { port: number }).port).toBe(0)
    expect(written.join("\n")).toContain("ACP 过渡版本，部分功能暂不可用")
    expect(written.join("\n")).toContain("http://127.0.0.1:43210/#c=")
    expect(opened).toEqual([fake.bridge.bootUrl()])
    expect(fake.stops).toEqual([{}])
  })

  test("--no-open：不开浏览器但仍打印地址；--port 透传", async () => {
    const fake = fakeBridge(9090)
    const opened: string[] = []
    const written: string[] = []
    const interrupts = makeInterrupts()
    const promise = runWeb(command({ open: false, port: 9090 }), {
      createBridge: fake.createBridge,
      openBrowser: async url => { opened.push(url) },
      write: line => written.push(line),
      lookup: LOOKUP,
      interrupts: interrupts.iterable,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    expect(await promise).toBe(0)
    expect(opened).toEqual([])
    expect((fake.created[0] as { port: number }).port).toBe(9090)
    expect(written.join("\n")).toContain("http://127.0.0.1:9090/#c=")
  })

  test("opener 失败：打印手动打开提示，命令继续运行", async () => {
    const fake = fakeBridge()
    const written: string[] = []
    const interrupts = makeInterrupts()
    const promise = runWeb(command(), {
      createBridge: fake.createBridge,
      openBrowser: async () => { throw new Error("no browser") },
      write: line => written.push(line),
      lookup: LOOKUP,
      interrupts: interrupts.iterable,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    expect(await promise).toBe(0)
    expect(written.join("\n")).toContain("无法自动打开浏览器")
  })

  test("第二次中断：stop 进行中再来一次 → stop({force:true})，返回 130", async () => {
    const fake = fakeBridge()
    fake.holdStop()
    const interrupts = makeInterrupts()
    const promise = runWeb(command({ open: false }), {
      createBridge: fake.createBridge,
      write: () => undefined,
      lookup: LOOKUP,
      interrupts: interrupts.iterable,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    await new Promise(resolve => setTimeout(resolve, 50))
    fake.releaseStop()
    expect(await promise).toBe(130)
    expect(fake.stops).toEqual([{}, { force: true }])
  })

  test("Windows：fail closed，不建桥", async () => {
    const fake = fakeBridge()
    await expect(runWeb(command(), {
      createBridge: fake.createBridge,
      platform: "win32",
      lookup: LOOKUP,
      interrupts: makeInterrupts().iterable,
    })).rejects.toThrow("Windows")
    expect(fake.created).toHaveLength(0)
  })

  test("sidecar 缺失：在绑端口之前抛 MISSING_AGENT", async () => {
    const fake = fakeBridge()
    await expect(runWeb(command(), {
      createBridge: fake.createBridge,
      lookup: { moduleDir: process.cwd(), env: { PATH: "/nonexistent" } },
      interrupts: makeInterrupts().iterable,
    })).rejects.toThrow("未找到 Harness 内核")
    expect(fake.created).toHaveLength(0)
  })

  test("spawn 计划：acp 参数、HARNESS_COMMAND_KIND、PYTHONSAFEPATH、--config 映射", async () => {
    const fake = fakeBridge()
    const interrupts = makeInterrupts()
    const promise = runWeb(command({ cwd: "/tmp", configPath: "/cfg.toml", open: false }), {
      createBridge: fake.createBridge,
      write: () => undefined,
      lookup: LOOKUP,
      interrupts: interrupts.iterable,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    await promise
    const plan = (fake.created[0] as { agentPlan: () => { args: string[]; cwd: string; env: NodeJS.ProcessEnv } }).agentPlan()
    expect(plan.args[plan.args.length - 1]).toBe("acp")
    expect(plan.env.HARNESS_COMMAND_KIND).toBe("acp")
    expect(plan.env.HARNESS_AGENT_CONFIG_PATH).toBe("/cfg.toml")
    expect(plan.env.PYTHONSAFEPATH).toBe("1")
    expect(plan.env.HARNESS_CLI_INSTALL_ROOT).toBeTruthy()
  })

  test("除地址行外，write 输出不含 bootCode", async () => {
    const code = "q".repeat(43)
    const fake = fakeBridge(43_210, code)
    const written: string[] = []
    const interrupts = makeInterrupts()
    const promise = runWeb(command({ open: false }), {
      createBridge: fake.createBridge,
      write: line => written.push(line),
      lookup: LOOKUP,
      interrupts: interrupts.iterable,
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    interrupts.fire("SIGINT")
    await promise
    const nonAddress = written.filter(line => !line.includes("#c=")).join("\n")
    expect(nonAddress).not.toContain(code)
    expect(written.filter(line => line.includes(code))).toHaveLength(1)
  })
})
