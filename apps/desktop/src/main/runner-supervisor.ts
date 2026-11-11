/** Electron 应用级 Runner 托管。真实子进程报告状态，停止须等原进程退出。 */
import { utilityProcess, type UtilityProcess } from "electron"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import type { LocalDeviceRegistration } from "@workbench/contracts"

export interface RunnerStartConfig {
  server: string
  secret: string
  dataDir: string
  projectRoot: string
  projectId: string
  projectName: string
  agentConfigId: string
  deviceId: string
  workspaceId: string
  ledgerId: string
  shareVersion: string
  shareEnabled: boolean
}

export type SupervisorState = "stopped" | "starting" | "offline" | "reconciling" | "ready" | "failed"

const runnerEntry = fileURLToPath(new URL("../../../runner/dist/index.js", import.meta.url))

export class RunnerSupervisor {
  #child: UtilityProcess | null = null
  #state: SupervisorState = "stopped"
  #listeners = new Set<(state: SupervisorState) => void>()
  #stop: Promise<boolean> | null = null
  #store: Promise<unknown> = Promise.resolve()

  onStateChanged(listener: (state: SupervisorState) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  #publish(state: SupervisorState) {
    this.#state = state
    for (const listener of this.#listeners) listener(state)
  }
  state(): SupervisorState { return this.#state }
  hasChild(): boolean { return this.#child !== null }

  /** 活跃 Runner 用原连接读写；未启动时只临时打开原账本。主进程不操作 SQLite。 */
  deviceStore(dataDir: string, origin: string, device?: LocalDeviceRegistration): Promise<LocalDeviceRegistration | null> {
    const operation = this.#store.catch(() => {}).then(async () => {
      const active = this.#child
      if (this.#stop) throw new Error("RUNNER_STOPPING")
      const child = active ?? utilityProcess.fork(runnerEntry, ["--device-store", dataDir], { env: {}, stdio: "pipe" })
      child.stdout?.resume()
      child.stderr?.resume()
      const requestId = randomUUID()
      return new Promise<LocalDeviceRegistration | null>((resolve, reject) => {
        let result: LocalDeviceRegistration | null = null
        let replied = false
        const finish = () => { clearTimeout(timer); child.removeListener("message", onMessage); child.removeListener("exit", onExit) }
        const onMessage = (message: { type?: string; requestId?: string; ok?: boolean; value?: LocalDeviceRegistration | null }) => {
          if (message.type !== "device-store-result" || message.requestId !== requestId) return
          if (!message.ok) { finish(); reject(new Error("LEDGER_MISMATCH")); return }
          replied = true
          result = message.value ?? null
          if (active) { finish(); resolve(result) }
        }
        const onExit = (code: number) => {
          finish()
          if (code === 0 && replied) resolve(result)
          else reject(new Error("LEDGER_UNAVAILABLE"))
        }
        const timer = setTimeout(() => {
          finish()
          if (!active) child.kill()
          reject(new Error("LEDGER_UNAVAILABLE"))
        }, 5000)
        child.on("message", onMessage)
        child.once("exit", onExit)
        child.postMessage({ type: "device-store", requestId, origin, action: device ? "save" : "load", device })
      })
    })
    this.#store = operation
    return operation
  }

  /** 从桌面构建产物定位同 workspace Runner，不依赖启动目录或环境覆盖入口。 */
  start(config: RunnerStartConfig): void {
    if (this.#child) return
    this.#publish("starting")
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(runnerEntry, [], {
        serviceName: "workbench-runner",
        env: {
          WORKBENCH_SERVER: config.server, WORKBENCH_DEVICE_SECRET: config.secret, WORKBENCH_DATA_DIR: config.dataDir,
          WORKBENCH_PROJECT_ROOT: config.projectRoot, WORKBENCH_PROJECT_ID: config.projectId, WORKBENCH_PROJECT_NAME: config.projectName,
          WORKBENCH_AGENT_CONFIG_ID: config.agentConfigId, WORKBENCH_DEVICE_ID: config.deviceId, WORKBENCH_WORKSPACE_ID: config.workspaceId,
          WORKBENCH_LEDGER_ID: config.ledgerId, WORKBENCH_SHARE_VERSION: config.shareVersion, WORKBENCH_SHARE_ENABLED: String(config.shareEnabled),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        },
        stdio: "pipe",
      })
    } catch {
      this.#publish("failed")
      return
    }
    this.#child = child
    child.stdout?.resume()
    child.stderr?.resume()
    child.on("message", message => {
      if (this.#child !== child || this.#stop || !message || message.type !== "state") return
      if (message.state === "offline" || message.state === "reconciling" || message.state === "ready") this.#publish(message.state)
    })
    child.once("exit", code => {
      if (this.#child !== child) return
      this.#child = null
      this.#publish(code === 0 ? "stopped" : "failed")
    })
  }

  /** 超时保留当前句柄，防止误把仍存活的进程当已停而另起一个。 */
  stop(timeoutMs = 5000): Promise<boolean> {
    if (this.#stop) return this.#stop
    const child = this.#child
    if (!child) return Promise.resolve(true)
    this.#stop = new Promise<boolean>(resolveExit => {
      const onExit = (code: number) => { clearTimeout(timer); resolveExit(code === 0) }
      const timer = setTimeout(() => { child.removeListener("exit", onExit); resolveExit(false) }, timeoutMs)
      child.once("exit", onExit)
      try { child.postMessage({ type: "stop" }) } catch { /* 保留原句柄，等待退出或超时 */ }
    }).then(stopped => {
      if (!stopped) this.#publish("failed")
      return stopped
    }).finally(() => { this.#stop = null })
    return this.#stop
  }
}
