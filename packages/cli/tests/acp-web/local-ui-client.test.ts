/**
 * `LocalUiClient`：真实控制器 + FakeAgent 网关。8 个切片齐全、
 * workspaceTree/git 为固定缺口值、同一快照返回同一对象引用、
 * interaction.deadlineAtMs 保持 Infinity（不经序列化）、close 幂等。
 */

import { describe, expect, test } from "bun:test"

import { AcpAgentGateway } from "../../src/acp-web/client/acp-agent-gateway"
import { createLocalUiClient } from "../../src/acp-web/client/local-ui-client"
import { createAcpCommandRegistry, createAcpRuntime } from "../../src/acp-web/client/runtime"
import { createInteractiveController } from "../../src/interactive/controller"
import { FakeAgent, pairedStreams } from "./support/fake-agent"

async function makeSession() {
  const agent = new FakeAgent()
  const { client, agent: agentStream } = pairedStreams()
  agent.attach(agentStream)
  const { gateway, boot } = await AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", commandsTimeoutMs: 10 })
  const controller = createInteractiveController({ gateway, baseRuntime: createAcpRuntime(boot) })
  return { agent, controller, client: createLocalUiClient({ controller }) }
}

describe("LocalUiClient", () => {
  test("8 个切片键齐全；workspaceTree 与 runtime.git 是固定缺口值", async () => {
    const { client } = await makeSession()
    const state = client.getState()
    expect(Object.keys(state).sort()).toEqual([
      "command", "conversation", "interaction", "navigation",
      "runtime", "workItem", "workspacePreview", "workspaceTree",
    ])
    expect(state.workspaceTree).toMatchObject({ status: "error", message: expect.stringContaining("GAP-11") })
    expect(state.workspacePreview).toEqual({ status: "idle" })
    expect(state.runtime.git).toMatchObject({ error: expect.stringContaining("GAP-12") })
    client.close()
  })

  test("同一快照 getState() 返回同一对象引用；快照变化后重算并通知订阅者", async () => {
    const { controller, client } = await makeSession()
    const first = client.getState()
    expect(client.getState()).toBe(first)
    const seen: unknown[] = []
    client.subscribeState(state => seen.push(state))
    await controller.dispatch({ type: "input.submit", value: "你好" })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(seen.length).toBeGreaterThan(0)
    expect(client.getState()).not.toBe(first)
    client.close()
  })

  test("interaction.deadlineAtMs 保持 Infinity（对象引用传递不序列化）", async () => {
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        await a.requestPermission(sessionId, {
          toolCallId: "x:1", title: "execute x",
          _meta: { harnessCode: { approval: { type: "approval", requestId: "int-1" } } },
        }, [{ optionId: "approve_once", name: "允许", kind: "allow_once" }])
        return { stopReason: "end_turn" }
      },
    })
    const { client: ws, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    const { gateway, boot } = await AcpAgentGateway.connect({ stream: ws, cwd: "/tmp/ws", commandsTimeoutMs: 10 })
    const controller = createInteractiveController({ gateway, baseRuntime: createAcpRuntime(boot) })
    const client = createLocalUiClient({ controller })
    await controller.dispatch({ type: "input.submit", value: "跑" })
    await new Promise(resolve => setTimeout(resolve, 50))
    const view = client.getState().interaction
    expect(view.interaction).not.toBeNull()
    expect((view.interaction as { deadlineAtMs: number }).deadlineAtMs).toBe(Number.POSITIVE_INFINITY)
    client.close()
  })

  test("ACP 命令表换掉之后，新建对话仍清空当前会话", async () => {
    const { controller, client } = await makeSession()
    await controller.dispatch({ type: "input.submit", value: "你好" })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(controller.getSnapshot().currentThreadId).not.toBeNull()
    controller.replaceCommandRegistry?.(createAcpCommandRegistry([]))
    const outcome = await controller.dispatch({ type: "command.execute", commandId: "thread.new" })
    expect(outcome).toMatchObject({ status: "accepted" })
    expect(controller.getSnapshot().currentThreadId).toBeNull()
    const notice = controller.getSnapshot().timeline.flatMap(item => (
      item.type === "message" ? [item.message.content] : []
    )).join("\n")
    expect(notice).not.toContain("未知命令")
    client.close()
    await controller.close()
  })

  test("handoff 固定 web-active；workspaceIntent 恒拒绝 GAP-11；close 幂等", async () => {
    const { controller, client } = await makeSession()
    expect(client.getHandoffState()).toEqual({ phase: "web-active", handoffId: "acp-local" })
    const outcome = await client.workspaceIntent({ type: "workspace.load" })
    expect(outcome).toMatchObject({ status: "rejected", code: "io-error", message: expect.stringContaining("GAP-11") })
    expect(await client.loadThreadTrace("t1")).toEqual({ spans: [], hasAnyTrace: false, error: null })
    client.close()
    client.close()
    await controller.close()
  })
})
