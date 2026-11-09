/**
 * Runner 生命周期：owner 锁 → 账本探测 → 项目登记 → 设备连接；停止时先断网再释放锁。
 * 生产缺少真实 ACP 执行端口时能力明确不可用，不注入假成功。
 */
import { join, resolve } from "node:path"
import { lstatSync } from "node:fs"
import {
  CommandHandler, DeviceConnection, Ledger, OwnerLock, ProjectRegistry, UnavailableExecutionPort,
  type ExecutionPort, type LocalDeviceRegistration,
} from "@workbench/runner-core"

export interface RunnerConfig {
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
  shareEnabled: boolean
  shareVersion: string
}

export function configFromEnv(env: NodeJS.ProcessEnv): RunnerConfig {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`缺少配置 ${name}`)
    return value
  }
  return {
    server: required("WORKBENCH_SERVER"),
    secret: required("WORKBENCH_DEVICE_SECRET"),
    dataDir: resolve(required("WORKBENCH_DATA_DIR")),
    projectRoot: resolve(required("WORKBENCH_PROJECT_ROOT")),
    projectId: required("WORKBENCH_PROJECT_ID"),
    projectName: env.WORKBENCH_PROJECT_NAME ?? "本机项目",
    agentConfigId: required("WORKBENCH_AGENT_CONFIG_ID"),
    deviceId: required("WORKBENCH_DEVICE_ID"),
    workspaceId: required("WORKBENCH_WORKSPACE_ID"),
    ledgerId: required("WORKBENCH_LEDGER_ID"),
    shareEnabled: env.WORKBENCH_SHARE_ENABLED === "true",
    shareVersion: required("WORKBENCH_SHARE_VERSION"),
  }
}

export interface RunningRunner {
  stop(): Promise<void>
  state(): string
  localDevice(origin: string): LocalDeviceRegistration | null
  saveLocalDevice(device: LocalDeviceRegistration): void
}

export function startRunner(config: RunnerConfig, port: ExecutionPort = new UnavailableExecutionPort(), onState?: (state: string) => void): RunningRunner {
  const ledgerPath = join(config.dataDir, "runner.sqlite")
  if (!lstatSync(ledgerPath, { throwIfNoEntry: false })?.isFile()) throw new Error("LEDGER_MISMATCH")
  const lock = OwnerLock.acquire(join(config.dataDir, "owner.sqlite"))
  let ledger: Ledger | null = null
  let connection: DeviceConnection | null = null
  try {
    ledger = Ledger.open(ledgerPath)
    ledger.requireIdentity(config.ledgerId)
    ledger.probe()
    ledger.markInterruptedExecutions()
    const registry = new ProjectRegistry(ledger)
    if (!ledger.project(config.projectId)) {
      registry.register({ id: config.projectId, root: config.projectRoot, name: config.projectName, shareEnabled: config.shareEnabled, shareVersion: config.shareVersion })
    }
    let state = "starting"
    const handler = new CommandHandler(ledger, port, registry, message => connection?.send(message))
    connection = new DeviceConnection({
      server: config.server, secret: config.secret, deviceId: config.deviceId, workspaceId: config.workspaceId, ledgerId: config.ledgerId, ledger, handler,
      onState: next => { state = next; onState?.(next) },
    })
    connection.start()
    const active = connection
    return {
      state: () => state,
      localDevice: origin => ledger!.localDevice(origin),
      saveLocalDevice: device => { ledger!.saveLocalDevice(device) },
      async stop() {
        active.stop()
        ledger?.close()
        lock.release()
      },
    }
  } catch (error) {
    ledger?.close()
    lock.release()
    throw error
  }
}
