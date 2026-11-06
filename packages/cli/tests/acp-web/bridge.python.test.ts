/**
 * 桥与真实 Python（`acp_scripted_main.py`）的联调用例。
 * `.venv` 缺失时整体跳过并输出原因；本机应实跑。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"

import { fakeChild } from "./support/fake-children"
import { startBridge, type BridgeHarness, type HarnessSocket } from "./support/bridge-harness"
import { makePythonWorkspace, pythonAgentPlan, pythonAvailable, type AcpScenario } from "./support/python-agent"
import { MAX_FRAME_BYTES } from "../../src/acp-web/bridge/framing"

const PYTHON_TIMEOUT = 30_000

if (!pythonAvailable) {
  console.warn("[bridge.python] 跳过：packages/agent/.venv/bin/python 不存在")
}

let harness: BridgeHarness | undefined

afterEach(async () => {
  await harness?.stop()
  harness = undefined
})

async function upPython(scenario: AcpScenario, overrides: Parameters<typeof startBridge>[1] = {}) {
  const workspace = realpathSync(makePythonWorkspace())
  harness = await startBridge(pythonAgentPlan(scenario, workspace), overrides)
  return { h: harness, workspace }
}

/** 发一条原始 JSON-RPC 帧。 */
function sendFrame(socket: HarnessSocket, frame: Record<string, unknown>): void {
  socket.ws.send(JSON.stringify(frame))
}

async function nextJson(socket: HarnessSocket): Promise<Record<string, unknown>> {
  return JSON.parse(await socket.nextMessage()) as Record<string, unknown>
}

/** 收帧直到拿到 id 匹配的响应；返回途中收集的所有帧。 */
async function untilResponse(socket: HarnessSocket, id: number): Promise<{ frames: Record<string, unknown>[]; response: Record<string, unknown> }> {
  const frames: Record<string, unknown>[] = []
  for (;;) {
    const frame = await nextJson(socket)
    frames.push(frame)
    if (frame.id === id) return { frames, response: frame }
  }
}

const EXT_DECLARATION = { harnessCode: { version: 1, capabilities: ["approval", "runSummary"] } }

describe.skipIf(!pythonAvailable)("桥 ⇄ 真实 Python", () => {
  test("stub 场景完整对话：update 排在响应之前", async () => {
    const { h, workspace } = await upPython("stub")
    const socket = h.openWs((await h.redeem()).body.wsToken!)
    await socket.opened

    sendFrame(socket, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })
    const init = await untilResponse(socket, 1)
    expect((init.response.result as { protocolVersion: number }).protocolVersion).toBe(1)

    sendFrame(socket, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workspace, mcpServers: [] } })
    const session = await untilResponse(socket, 2)
    const sessionId = (session.response.result as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    sendFrame(socket, {
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    const prompt = await untilResponse(socket, 3)
    const updates = prompt.frames.filter(f => f.method === "session/update")
    expect(updates.length).toBeGreaterThan(0)
    // 所有 update 都排在响应之前（untilResponse 的顺序即收到顺序）。
    const lastUpdate = prompt.frames.lastIndexOf(updates[updates.length - 1]!)
    expect(lastUpdate).toBeLessThan(prompt.frames.length - 1)
    expect((prompt.response.result as { stopReason: string }).stopReason).toBe("end_turn")
    socket.ws.close()
    await h.waitForDrained(10_000)
  }, PYTHON_TIMEOUT)

  test("host 场景回显：扩展协商后响应带 _meta.harnessCode.run", async () => {
    const { h, workspace } = await upPython("host")
    const socket = h.openWs((await h.redeem()).body.wsToken!)
    await socket.opened

    sendFrame(socket, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { _meta: EXT_DECLARATION } },
    })
    await untilResponse(socket, 1)
    sendFrame(socket, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workspace, mcpServers: [] } })
    const session = await untilResponse(socket, 2)
    const sessionId = (session.response.result as { sessionId: string }).sessionId

    sendFrame(socket, {
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "你好" }] },
    })
    const prompt = await untilResponse(socket, 3)
    const echoed = prompt.frames.some(frame => {
      const params = frame.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined
      return params?.update?.sessionUpdate === "agent_message_chunk"
        && params.update.content?.text?.includes("你好") === true
    })
    expect(echoed).toBe(true)
    const result = prompt.response.result as { stopReason: string; _meta?: { harnessCode?: { run?: { usage?: unknown } } } }
    expect(result.stopReason).toBe("end_turn")
    expect(result._meta?.harnessCode?.run?.usage).toBeTruthy()
    socket.ws.close()
    await h.waitForDrained(10_000)
  }, PYTHON_TIMEOUT)

  test("block 场景取消：session/cancel → stopReason cancelled", async () => {
    const { h, workspace } = await upPython("block")
    const socket = h.openWs((await h.redeem()).body.wsToken!)
    await socket.opened
    sendFrame(socket, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })
    await untilResponse(socket, 1)
    sendFrame(socket, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workspace, mcpServers: [] } })
    const session = await untilResponse(socket, 2)
    const sessionId = (session.response.result as { sessionId: string }).sessionId
    sendFrame(socket, {
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    // 等第一条 update 证明 prompt 已在途，再发取消通知。
    for (;;) {
      const frame = await nextJson(socket)
      if (frame.method === "session/update") break
    }
    sendFrame(socket, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
    const prompt = await untilResponse(socket, 3)
    expect((prompt.response.result as { stopReason: string }).stopReason).toBe("cancelled")
    socket.ws.close()
    await h.waitForDrained(10_000)
  }, PYTHON_TIMEOUT)

  test("approval 场景：挂起审批被收敛为 cancelled，随后可立即再发", async () => {
    const { h, workspace } = await upPython("approval")
    const socket = h.openWs((await h.redeem()).body.wsToken!)
    await socket.opened
    sendFrame(socket, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { _meta: EXT_DECLARATION } },
    })
    await untilResponse(socket, 1)
    sendFrame(socket, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workspace, mcpServers: [] } })
    const session = await untilResponse(socket, 2)
    const sessionId = (session.response.result as { sessionId: string }).sessionId

    sendFrame(socket, {
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    // 收到权限请求帧（agent → client 的 JSON-RPC request，有自己的 id）。
    let permissionId: number | undefined
    for (;;) {
      const frame = await nextJson(socket)
      if (frame.method === "session/request_permission") {
        permissionId = frame.id as number
        break
      }
    }
    expect(permissionId).toBeDefined()
    // 取消 Run，并按 ACP 约定对挂起的权限请求回 cancelled。
    sendFrame(socket, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
    sendFrame(socket, { jsonrpc: "2.0", id: permissionId, result: { outcome: { outcome: "cancelled" } } })
    const first = await untilResponse(socket, 3)
    expect((first.response.result as { stopReason: string }).stopReason).toBe("cancelled")

    // 立即再发：又收到权限请求 → 回 selected approve_once → end_turn。
    sendFrame(socket, {
      jsonrpc: "2.0", id: 4, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "again" }] },
    })
    permissionId = undefined
    const second = { frames: [] as Record<string, unknown>[], response: undefined as Record<string, unknown> | undefined }
    for (;;) {
      const frame = await nextJson(socket)
      second.frames.push(frame)
      if (frame.method === "session/request_permission" && permissionId === undefined) {
        permissionId = frame.id as number
        sendFrame(socket, {
          jsonrpc: "2.0", id: permissionId,
          result: { outcome: { outcome: "selected", optionId: "approve_once" } },
        })
      }
      if (frame.id === 4) {
        second.response = frame
        break
      }
    }
    expect((second.response!.result as { stopReason: string }).stopReason).toBe("end_turn")
    socket.ws.close()
    await h.waitForDrained(10_000)
  }, PYTHON_TIMEOUT)

  test("浏览器关闭：block 进行中断连 → Python 在宽限内以 0 退出，无升级", async () => {
    const { h, workspace } = await upPython("block", { limits: { exitGraceMs: 3_000, termGraceMs: 400 } })
    const socket = h.openWs((await h.redeem()).body.wsToken!)
    await socket.opened
    sendFrame(socket, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })
    await untilResponse(socket, 1)
    sendFrame(socket, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workspace, mcpServers: [] } })
    const session = await untilResponse(socket, 2)
    const sessionId = (session.response.result as { sessionId: string }).sessionId
    sendFrame(socket, {
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    })
    for (;;) {
      const frame = await nextJson(socket)
      if (frame.method === "session/update") break
    }
    socket.ws.close()
    const exited = await h.waitForEvent(event => event.event === "agent.exited", 15_000)
    expect(exited.event === "agent.exited" && exited.expected).toBe(true)
    expect(exited.event === "agent.exited" && exited.code).toBe(0)
    expect(h.events.filter(event => event.event === "agent.escalated")).toEqual([])
    await h.waitForDrained(10_000)
  }, PYTHON_TIMEOUT)

  test("超限入站帧：8 MiB + 1 → 连接关闭，Python 被回收", async () => {
    const { h } = await upPython("stub")
    const socket = h.openWs((await h.redeem()).body.wsToken!)
    await socket.opened
    socket.ws.send(`{${"a".repeat(MAX_FRAME_BYTES)}}`)
    const closed = await socket.closed
    expect([1006, 1009]).toContain(closed.code)
    await h.waitForDrained(10_000)
  }, PYTHON_TIMEOUT)
})
