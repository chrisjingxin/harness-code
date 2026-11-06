/**
 * 审批无超时锁定（Todo 3.14 / 设计 §6.5）：网关发 `timeout_ms: Infinity`
 * → 控制器不装定时器、`deadlineAtMs` 为 Infinity；时间推进 25 小时
 * 并 runAll 后交互仍 pending、权限请求未应答；用户批准后应答
 * `selected{approve_once}`，Run 继续并以 end_turn 收尾。
 */

import { describe, expect, test } from "bun:test"

import { AcpAgentGateway } from "../../src/acp-web/client/acp-agent-gateway"
import { createInteractiveController } from "../../src/interactive/controller"
import { manualScheduler } from "../interactive/harness"
import { FakeAgent, pairedStreams } from "./support/fake-agent"

describe("审批无超时（controller + AcpAgentGateway + manualScheduler）", () => {
  test("deadlineAtMs 为 Infinity、无定时器、25h 后仍 pending；批准后应答 selected", async () => {
    const approvalToolCall = {
      toolCallId: "x:call-1",
      kind: "execute",
      status: "pending",
      title: "execute npm test",
      rawInput: { command: "npm test" },
      _meta: { harnessCode: { approval: { type: "approval", requestId: "int-1", description: "跑一下" } } },
    }
    let permissionOutcome: { outcome: unknown } | null = null
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const outcome = await a.requestPermission(sessionId, approvalToolCall, [
          { optionId: "approve_once", name: "允许一次", kind: "allow_once" },
          { optionId: "reject", name: "拒绝", kind: "reject_once" },
        ]) as { outcome: unknown }
        permissionOutcome = outcome
        return { stopReason: "end_turn" }
      },
    })
    const { client, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    const { gateway, boot } = await AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", now: () => 1, settleCommandsMs: 20 })

    const { scheduler, runAll, runExpired } = manualScheduler()
    const controller = createInteractiveController({
      gateway,
      baseRuntime: gateway.runtime,
      scheduler,
      // 浏览器侧没有文件系统：提交通道直通即可。
      resolveMentions: async (_root, text) => ({ resolved: [], inlinedCount: 0, referenceCount: 0, totalBytes: 0, contextBlock: "", prompt: text }),
    })

    await controller.dispatch({ type: "input.submit", value: "跑测试" })

    // 审批到达：snapshot.interaction 为 pending，deadlineAtMs 为 Infinity。
    await new Promise(resolve => setTimeout(resolve, 30))
    // interaction 切片只在挂起时出现：存在即 pending。
    const interaction = controller.getSnapshot().interaction
    expect(interaction).not.toBeNull()
    expect(interaction?.deadlineAtMs).toBe(Number.POSITIVE_INFINITY)

    // 没有为该交互登记任何定时器：把所有到期回调跑一遍，交互仍 pending。
    runAll()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(controller.getSnapshot().interaction).not.toBeNull()
    // 模拟推进 25 小时：即使有定时器也应已过期，但交互不受影响。
    expect(runExpired()).toBe(0)
    expect(controller.getSnapshot().interaction).not.toBeNull()
    expect(permissionOutcome).toBeNull()

    // 用户点批准 → selected{approve_once} 回到 Agent → Run 以 end_turn 结束。
    await controller.dispatch({
      type: "interaction.respond",
      requestId: interaction!.requestId,
      response: { kind: "approval", decision: "approve_once" },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(permissionOutcome).not.toBeNull()
    expect(permissionOutcome!.outcome).toEqual({ outcome: "selected", optionId: "approve_once" })
    expect(controller.getSnapshot().interaction).toBeNull()
    await controller.close()
  })
})
