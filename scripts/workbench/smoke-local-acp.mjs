/** HC-197 必要冒烟。通过 Electron 主进程使用的工厂调用已配置的 Agent。 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopLocalAcpHost } from "../../apps/desktop/src/main/local-acp-host.ts"

const host = createDesktopLocalAcpHost()
const firstOnly = process.argv.includes("--first")
const root = await mkdtemp(join(tmpdir(), "hc197-"))
const scope = {
  accountId: "smoke-account", workspaceId: "smoke-team",
  projectId: "smoke-project", conversationId: "smoke-session",
}

async function send(session, prompt) {
  const events = []
  let unsubscribe
  let timeout
  try {
    const terminal = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("等待文本终态超时")), 60_000)
      unsubscribe = session.subscribe(event => {
        events.push(event)
        if (event.type !== "text-delta") resolve(event)
      })
    })
    assert.deepEqual(session.getAvailability(), { available: true })
    const receipt = session.send(prompt)
    console.log("受理", JSON.stringify(receipt))
    assert.equal(receipt.status, "accepted")
    assert.deepEqual(session.send(prompt), { status: "rejected", reason: "session-busy" })
    const result = await terminal
    console.log("事件", JSON.stringify(events))
    assert.equal(result.type, "completed", JSON.stringify(result))
    assert.ok(events.filter(event => event.type === "text-delta").length >= 2, "需要收到分段正文")
    assert.ok(events.every((event, index) => event.turnId === receipt.turnId && event.sequence === index + 1))
    assert.deepEqual(session.getAvailability(), { available: true })
    return receipt.turnId
  } finally {
    clearTimeout(timeout)
    unsubscribe?.()
  }
}

try {
  const firstRoot = await mkdir(join(root, "first"), { recursive: true })
  if (firstOnly) {
    const session = await host.bind(scope, firstRoot)
    await send(session, "Reply with a short hello. Do not use any tools.")
    await host.close()
    console.log("首轮流式正文与终态已收到，子进程确认退出")
  } else {
    await smokeIsolation(firstRoot)
  }
} finally {
  try { await host.close() } finally { await rm(root, { recursive: true, force: true }) }
}

async function smokeIsolation(firstRoot) {
  const secondRoot = await mkdir(join(root, "second"), { recursive: true })
  const first = await host.bind(scope, firstRoot)
  assert.equal(await host.bind(scope, firstRoot), first)
  await assert.rejects(host.bind(scope, secondRoot))
  const second = await host.bind({ ...scope, accountId: "another-smoke-account" }, secondRoot)

  const firstEvents = []
  const secondEvents = []
  first.subscribe(event => firstEvents.push(event))
  second.subscribe(event => secondEvents.push(event))
  const firstTurn = await send(first, "Reply with a short hello. Do not use any tools.")
  const secondTurn = await send(first, "Reply with a short goodbye. Do not use any tools.")
  assert.equal(secondEvents.length, 0)
  const thirdTurn = await send(second, "Reply with a short greeting. Do not use any tools.")
  assert.equal(new Set([firstTurn, secondTurn, thirdTurn]).size, 3)
  assert.ok(firstEvents.every(event => event.turnId !== thirdTurn))
  assert.ok(secondEvents.every(event => event.turnId === thirdTurn))
  await host.close()
  assert.deepEqual(first.getAvailability(), { available: false, reason: "session-closed" })
  console.log("同一会话再次发送、不同绑定事件隔离、子进程确认退出")
}
