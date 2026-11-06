/**
 * `session.integration`：真实桥 + 真实 `acp_scripted_main.py` + bun 的真实
 * `WebSocket`（无浏览器）走完 `bootAcpTransport → createWebSocketStream →
 * composeAcpWebSession`：发"你好"→ 控制器时间线出现用户消息与助手回显；
 * `runtime.workspace === cwd`；`session.close()` 后桥侧子进程被回收。
 */

import { describe, expect, test, afterEach } from "bun:test"

import { bootAcpTransport } from "../../src/acp-web/client/boot"
import { composeAcpWebSession } from "../../src/acp-web/client/session"
import { createWebSocketStream } from "../../src/acp-web/client/ws-stream"
import { makePythonWorkspace, pythonAgentPlan, pythonAvailable } from "./support/python-agent"
import { startBridge, type BridgeHarness } from "./support/bridge-harness"
import { realpathSync } from "node:fs"

let harness: BridgeHarness | null = null
afterEach(async () => {
  await harness?.stop()
  harness = null
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("等待条件超时")
    await wait(20)
  }
}

describe("session 集成：真实桥 + 真实 Python（host 场景）", () => {
  test("boot → ws → session → 一轮对话 → close 回收子进程", async () => {
    if (!pythonAvailable) return
    const workspace = realpathSync(makePythonWorkspace())
    harness = await startBridge(pythonAgentPlan("host", workspace), { cwd: workspace })

    // 浏览器侧：注入真实 fetch（补 Origin 头）与真实 WebSocket。
    const transport = await bootAcpTransport({
      location: { hash: `#c=${harness.bootCode}`, host: `127.0.0.1:${harness.port}`, pathname: "/" },
      history: { replaceState: () => {} },
      storage: null,
      fetch: ((url: string, init?: RequestInit) => fetch(`${harness!.origin}${url}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), origin: harness!.origin },
      })) as typeof fetch,
      createSocket: url => new WebSocket(url, { headers: { origin: harness!.origin } } as never) as WebSocket,
      sleep: wait,
    })
    expect(transport.cwd).toBe(workspace)

    const { stream, closed, close } = createWebSocketStream(transport.socket)
    const session = await composeAcpWebSession({ stream, cwd: transport.cwd, closed })

    // 会话的 runtime.workspace 就是工作区（host 场景的 cwd）。
    const state = session.client.getState()
    expect(state.runtime.runtime.workspace).toBe(workspace)

    // 发一条消息 → 时间线出现用户消息 + 助手回显（host 场景回显 prompt 文本）。
    await session.client.submitIntent({ type: "input.submit", value: "你好" })
    await until(() => {
      const items = session.client.getState().conversation.timeline as Array<{
        type: string
        message?: { role?: string; content?: string }
      }>
      return items.some(i => i.message?.role === "user" && i.message.content === "你好")
        && items.some(i => i.message?.role === "assistant" && i.message.content === "你好")
    }, 15_000)
    const timeline = session.client.getState().conversation.timeline
    expect(timeline.length).toBeGreaterThan(0)

    await session.close()
    close(1000, "test-done")
    await harness.waitForDrained()
  }, 20_000)
})
