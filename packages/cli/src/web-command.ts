/**
 * `harness web` 命令：启动 ACP Web 桥并常驻，直到用户中断。
 *
 * 流程：Windows fail closed → realpath 工作区 → 预检 sidecar spawn 计划 →
 * 建桥绑定随机端口 → 打印地址（bootCode 在 URL fragment 里，不出现在
 * Referer/日志/服务器请求行）→ 可选开浏览器 → 等中断 → 优雅 stop。
 * 第二次 Ctrl+C 升级为 stop({force:true}) 强杀残余子进程并返回 130。
 */

import { realpathSync } from "node:fs"

import { buildAcpSpawnPlan, type AcpSpawnPlan } from "./acp-command"
import type { AcpWebAssetProvider } from "./acp-web/bridge/assets"
import { browserBundle } from "./acp-web/bundle"
import { createAcpWebBridge } from "./acp-web/bridge/bridge"
import type { Command } from "./args"
import { createSystemBrowserOpener } from "./web/browser"
import type { WebBrowserOpener } from "./presentation-coordinator"

export type WebCommand = Extract<Command, { kind: "web" }>

export type WebCommandDeps = {
  createBridge?: typeof createAcpWebBridge
  assets?: AcpWebAssetProvider
  openBrowser?: WebBrowserOpener
  write?: (line: string) => void
  platform?: NodeJS.Platform
  lookup?: { moduleDir: string; env: NodeJS.ProcessEnv }
  interrupts?: AsyncIterable<NodeJS.Signals>
}

function processInterrupts(): { iterable: AsyncIterable<NodeJS.Signals>; dispose: () => void } {
  const queue: NodeJS.Signals[] = []
  const waiters: Array<() => void> = []
  let done = false
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
  if (process.platform !== "win32") signals.push("SIGHUP")
  const handler = (signal: NodeJS.Signals) => {
    queue.push(signal)
    waiters.splice(0).forEach(resolve => resolve())
  }
  for (const signal of signals) process.on(signal, handler)
  return {
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift()
          if (next) yield next
          else if (done) return
          else await new Promise<void>(resolve => waiters.push(resolve))
        }
      },
    },
    dispose: () => {
      for (const signal of signals) process.off(signal, handler)
      // Bun 会把"挂在生成器内部 await 上的 next()"当成未决工作钉住事件循环；
      // 唤醒它让生成器走到 return，runWeb 返回后进程才能自然退出。
      done = true
      waiters.splice(0).forEach(resolve => resolve())
    },
  }
}

export async function runWeb(command: WebCommand, deps: WebCommandDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform
  // fail closed：Windows 路径/信号语义未覆盖，明确拒绝而不是半工作。
  if (platform === "win32") {
    throw new Error("harness web 暂不支持 Windows（fail closed）")
  }
  const write = deps.write ?? ((line: string) => console.log(line))
  const cwd = realpathSync(command.cwd)
  // 预检一次 spawn 计划：sidecar 缺失时在绑定端口之前抛 MISSING_AGENT。
  const plan = (): AcpSpawnPlan => buildAcpSpawnPlan(
    { kind: "acp", cwd, configPath: command.configPath },
    deps.lookup ?? { moduleDir: import.meta.dir, env: process.env },
  )
  plan()
  const bridge = (deps.createBridge ?? createAcpWebBridge)({
    cwd,
    agentPlan: plan,
    assets: deps.assets ?? browserBundle,
    port: command.port ?? 0,
  })
  const { origin } = await bridge.start()
  const bootUrl = bridge.bootUrl()
  write("Harness Code Web（ACP 过渡版本，部分功能暂不可用）")
  write("暂不支持的功能见 docs/user/Web界面.md「ACP 入口当前不支持的功能」")
  write(`工作区  ${cwd}`)
  write(`地址    ${bootUrl}`)
  write("Ctrl+C 退出")
  if (command.open) {
    try {
      await (deps.openBrowser ?? createSystemBrowserOpener())(bootUrl)
    } catch {
      write("无法自动打开浏览器，请手动访问上面的地址")
    }
  }
  const source = deps.interrupts ? null : processInterrupts()
  const iterable = deps.interrupts ?? source!.iterable
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    await iterator.next() // 第一次中断
    const graceful = bridge.stop().then(() => 0)
    const forced = iterator.next().then(result => {
      // dispose 唤醒后 next() 会返回 done:true——那是收尾路径，不是第二次中断。
      if (result.done) return 0
      // 第二次中断：不等结果直接升级强杀并返回 130；bridge.stop 的升级路径
      // 会同步对残余子进程补 SIGKILL，进程随即退出。
      void bridge.stop({ force: true })
      return 130
    })
    return await Promise.race([graceful, forced])
  } finally {
    // 不调 iterator.return()：生成器可能挂在一个永不 resolve 的 await 上，
    // return() 会等它而卡住退出。残余的 pending 引用没有句柄，交给 GC。
    source?.dispose()
  }
}
