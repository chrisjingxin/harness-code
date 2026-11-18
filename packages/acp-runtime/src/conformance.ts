/**
 * 标准 ACP 一致性测试运行器（对照 `Agent接入架构.md` §6）。
 *
 * 按纯标准 ACP 协议验证任意 Agent：
 * 1. `initialize` + `newSession` + 流式 `prompt`（序号 1..N 连续且有完成终态）；
 * 2. `tool_call` 工具生命周期；
 * 3. `requestPermission` 权限审批请求与作答；
 * 4. `cancel` 取消轮次收敛及随后再次发送恢复；
 * 5. `loadSession` 恢复与回放隔离，或不支持/失败时的 `fallback-new` 自动重置；
 * 6. 畸形 stdout 帧防泄漏与失败关闭健壮性；
 * 7. 关闭 stdin EOF 后进程干净退出。
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentCapabilities } from "@agentclientprotocol/sdk"
import {
  LocalAcpHost,
  type AgentCommand,
  type LocalAcpEvent,
  type LocalAcpHostOptions,
  type LocalAcpImplementation,
  type LocalAcpScope,
  type LocalAcpSession,
  type LocalAcpSessionUpdateEvent,
} from "./index.js"

export type AcpConformanceCheckStatus = "pass" | "fail" | "skip"

export type AcpConformanceCheck = {
  readonly id: string
  readonly category: "handshake" | "session" | "run" | "interaction" | "robustness"
  readonly name: string
  readonly status: AcpConformanceCheckStatus
  readonly detail?: string
  readonly durationMs: number
}

export type AcpConformanceOptions = {
  readonly cwd?: string
  readonly bindingDirectory?: string
  readonly promptText?: string
  readonly toolPromptText?: string
  readonly permissionPromptText?: string
  readonly cancelPromptText?: string
  readonly restorePromptText?: string
  readonly requireTools?: boolean
  readonly requirePermission?: boolean
  readonly malformedStdoutCommand?: AgentCommand
  readonly timeoutMs?: number
  readonly hostOptions?: Omit<LocalAcpHostOptions, "bindingDirectory">
}

export type AcpConformanceReport = {
  readonly passed: boolean
  readonly agentInfo?: LocalAcpImplementation
  readonly agentCapabilities?: AgentCapabilities
  readonly protocolVersion?: number
  readonly checks: readonly AcpConformanceCheck[]
  readonly summary: {
    readonly pass: number
    readonly fail: number
    readonly skip: number
  }
}

const DEFAULT_TIMEOUT_MS = 15_000
const TURN_EVENT_TYPES = new Set([
  "text-delta",
  "thought-delta",
  "tool",
  "permission",
  "completed",
  "cancelled",
  "failed",
])

function assertContiguousTurnEvents(events: readonly LocalAcpEvent[]): void {
  assert.ok(events.length >= 1, "轮次必须至少包含终态事件")
  const turnId = events[0]!.turnId
  events.forEach((event, index) => {
    assert.equal(event.turnId, turnId, "同一轮事件 turnId 必须一致")
    assert.equal(event.sequence, index + 1, "轮次事件 sequence 必须从 1 连续递增")
    assert.ok(TURN_EVENT_TYPES.has(event.type), `存在非标准轮次事件类型：${event.type}`)
  })
}

async function runPromptTurn(
  session: LocalAcpSession,
  text: string,
  timeoutMs: number,
  onEvent?: (event: LocalAcpEvent, turnId: string) => void,
): Promise<LocalAcpEvent[]> {
  const events: LocalAcpEvent[] = []
  let unsub = () => {}
  let turnId = ""
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待轮次结束超时 (${timeoutMs}ms)：${text}`)), timeoutMs)
    unsub = session.subscribe(event => {
      events.push(event)
      onEvent?.(event, turnId)
      if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  try {
    const receipt = session.send(text)
    assert.equal(receipt.status, "accepted", `send 被拒绝：${JSON.stringify(receipt)}`)
    if (receipt.status !== "accepted") throw new Error("send rejected")
    turnId = receipt.turnId
    await finished
    assertContiguousTurnEvents(events)
    return events
  } finally {
    unsub()
  }
}

async function runCheck(
  id: string,
  category: AcpConformanceCheck["category"],
  name: string,
  action: () => Promise<{ readonly status?: AcpConformanceCheckStatus; readonly detail?: string } | void>,
): Promise<AcpConformanceCheck> {
  const started = Date.now()
  try {
    const outcome = await action()
    return {
      id,
      category,
      name,
      status: outcome?.status ?? "pass",
      ...(outcome?.detail ? { detail: outcome.detail } : {}),
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      id,
      category,
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    }
  }
}

/** 验证运行器面对非法 stdout 行时必须在握手/轮次中失败关闭，且不把原始内容暴露进正文。 */
function defaultMalformedStdoutCommand(): AgentCommand {
  const script = `
    process.stdout.write("not-a-jsonrpc-banner\\n")
    process.stdin.resume()
  `
  return {
    executable: process.execPath,
    args: ["--input-type=module", "-e", script],
    env: process.env,
  }
}

/** 对目标 ACP Agent 执行全套标准一致性检查并产出能力报告。 */
export async function runAcpConformanceSuite(
  command: AgentCommand,
  options: AcpConformanceOptions = {},
): Promise<AcpConformanceReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ownWorkspace = !options.cwd
  const ownBindingDir = !options.bindingDirectory
  const workspace = options.cwd ?? await mkdtemp(join(tmpdir(), "acp-conformance-ws-"))
  const bindingDirectory = options.bindingDirectory ?? await mkdtemp(join(tmpdir(), "acp-conformance-bind-"))
  const scope: LocalAcpScope = {
    accountId: "conformance-account",
    workspaceId: "conformance-workspace",
    projectId: "conformance-project",
    conversationId: "conformance-conversation",
  }

  const checks: AcpConformanceCheck[] = []
  let agentInfo: LocalAcpImplementation | undefined
  let agentCapabilities: AgentCapabilities | undefined
  let protocolVersion: number | undefined

  const host = new LocalAcpHost(command, {
    ...options.hostOptions,
    bindingDirectory,
    handshakeTimeoutMs: options.hostOptions?.handshakeTimeoutMs ?? timeoutMs,
  })

  try {
    const session = await host.bind(scope, workspace)

    checks.push(await runCheck("handshake-new-session-stream", "handshake", "握手建会与流式正文输出", async () => {
      const events = await runPromptTurn(session, options.promptText ?? "hello", timeoutMs)
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "completed", `期望 completed，实际收到 ${JSON.stringify(terminal)}`)
      assert.ok(events.some(e => e.type === "text-delta" && e.text.length > 0), "缺少 text-delta 流式正文")
      const state = session.getState()
      protocolVersion = state.protocolVersion
      agentInfo = state.agentInfo
      agentCapabilities = state.agentCapabilities
      assert.equal(state.protocolVersion, 1)
      assert.ok(state.sessionId)
      assert.equal(state.restoreStatus.kind, "new")
      return { detail: `sessionId=${state.sessionId}` }
    }))

    checks.push(await runCheck("tool-call-lifecycle", "run", "工具调用生命周期映射", async () => {
      const events = await runPromptTurn(session, options.toolPromptText ?? "tool", timeoutMs)
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "completed", `期望 completed，实际收到 ${JSON.stringify(terminal)}`)
      const tools = events.filter((e): e is Extract<LocalAcpEvent, { type: "tool" }> => e.type === "tool")
      if (!tools.length && options.requireTools === false) {
        return { status: "skip", detail: "Agent 未触发 tool_call（按配置跳过）" }
      }
      assert.ok(tools.length >= 1, "未收到 tool 事件")
      assert.ok(tools.some(t => t.tool.status === "completed" || t.tool.status === "failed"), "未收到终态工具更新")
      return { detail: `toolEvents=${tools.length}` }
    }))

    checks.push(await runCheck("request-permission", "interaction", "权限审批请求与应答", async () => {
      let answered = false
      const events = await runPromptTurn(session, options.permissionPromptText ?? "permission", timeoutMs, (ev, turnId) => {
        if (ev.type === "permission" && ev.request) {
          const allowOption = ev.request.options.find(opt => opt.allows) ?? ev.request.options[0]
          assert.ok(allowOption, "权限请求缺少可选选项")
          assert.equal(session.answerPermission(turnId, ev.request.id, allowOption.id), true)
          answered = true
        }
      })
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "completed", `期望 completed，实际收到 ${JSON.stringify(terminal)}`)
      if (!answered && options.requirePermission === false) {
        return { status: "skip", detail: "Agent 未触发 requestPermission（按配置跳过）" }
      }
      assert.equal(answered, true, "未触发权限审批请求或未能回答")
      assert.equal(events.some(e => e.type === "permission" && e.request === null), true, "审批回答后应清空挂起请求")
      return { detail: "permission answered and cleared" }
    }))

    checks.push(await runCheck("cancel-turn", "run", "取消运行并恢复可用状态", async () => {
      let cancelSent = false
      const events = await runPromptTurn(session, options.cancelPromptText ?? "slow", timeoutMs, (ev, turnId) => {
        if (!cancelSent && (ev.type === "text-delta" || ev.type === "tool")) {
          cancelSent = session.cancel(turnId)
        }
      })
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "cancelled", `期望 cancelled，实际收到 ${JSON.stringify(terminal)}`)
      assert.equal(session.getAvailability().available, true, "取消后会话应恢复可用")
      const followUp = await runPromptTurn(session, options.promptText ?? "hello", timeoutMs)
      assert.equal(followUp.at(-1)?.type, "completed", "取消后再次发送应成功完成")
      return { detail: "cancelled cleanly and resumed" }
    }))

    checks.push(await runCheck("clean-eof-exit", "robustness", "关闭宿主与 stdin EOF 后进程退出", async () => {
      await host.close()
      return { detail: "host.close() resolved cleanly" }
    }))

    checks.push(await runCheck("session-restore-or-fallback", "session", "原生会话恢复或回退新建", async () => {
      const host2 = new LocalAcpHost(command, {
        ...options.hostOptions,
        bindingDirectory,
        restorePolicy: "fallback-new",
        handshakeTimeoutMs: options.hostOptions?.handshakeTimeoutMs ?? timeoutMs,
      })
      try {
        const session2 = await host2.bind(scope, workspace)
        const sessionEvents: LocalAcpSessionUpdateEvent[] = []
        session2.subscribeSession(ev => sessionEvents.push(ev))
        const events = await runPromptTurn(session2, options.restorePromptText ?? "followup", timeoutMs)
        assert.equal(events.at(-1)?.type, "completed")
        const state = session2.getState()
        const hadLeak = events.some(e => e.type === "text-delta" && e.text.includes("replayed-"))
        assert.equal(hadLeak, false, "回放帧不得泄漏到轮次 subscribe() 事件流")
        if (agentCapabilities?.loadSession) {
          assert.equal(state.restoreStatus.kind, "restored", `支持 loadSession 时应 restored，实际为 ${state.restoreStatus.kind}`)
          return { detail: `restored (${sessionEvents.filter(e => e.type === "replay").length} replay frames)` }
        }
        assert.equal(state.restoreStatus.kind, "reset", `不支持 loadSession 时应 fallback-new reset，实际为 ${state.restoreStatus.kind}`)
        assert.equal(sessionEvents.some(e => e.type === "session-reset"), true)
        return { detail: `reset (${state.restoreStatus.reason})` }
      } finally {
        await host2.close()
      }
    }))

    checks.push(await runCheck("malformed-stdout-resilience", "robustness", "畸形 stdout 帧防泄漏与失败关闭", async () => {
      const malformedCmd = options.malformedStdoutCommand ?? defaultMalformedStdoutCommand()
      const malformedHost = new LocalAcpHost(malformedCmd, {
        handshakeTimeoutMs: Math.min(timeoutMs, 3_000),
      })
      try {
        const badSession = await malformedHost.bind({
          ...scope,
          conversationId: "conformance-malformed",
        }, workspace)
        const events = await runPromptTurn(badSession, "ping", Math.min(timeoutMs, 5_000))
        const terminal = events.at(-1)
        assert.equal(terminal?.type, "failed", `畸形 stdout 必须以 failed 结束，实际为 ${JSON.stringify(terminal)}`)
        const leaked = events.some(e => e.type === "text-delta" && e.text.includes("not-a-jsonrpc-banner"))
        assert.equal(leaked, false, "畸形 stdout 原文不得进入正文事件")
        return { detail: `failed closed (${terminal.reason})` }
      } finally {
        await malformedHost.close()
      }
    }))
  } finally {
    await host.close().catch(() => {})
    if (ownWorkspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
    if (ownBindingDir) await rm(bindingDirectory, { recursive: true, force: true }).catch(() => {})
  }

  const summary = {
    pass: checks.filter(c => c.status === "pass").length,
    fail: checks.filter(c => c.status === "fail").length,
    skip: checks.filter(c => c.status === "skip").length,
  }
  return {
    passed: summary.fail === 0,
    ...(agentInfo ? { agentInfo } : {}),
    ...(agentCapabilities ? { agentCapabilities } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    checks,
    summary,
  }
}
