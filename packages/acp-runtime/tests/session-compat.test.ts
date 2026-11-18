/** HC-226：通用 ACP 会话状态、全量 SessionUpdate、控制方法、原生绑定恢复/重置与可选表单交互测试。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  LocalAcpHost,
  type LocalAcpEvent,
  type LocalAcpSessionUpdateEvent,
} from "../dist/index.js"
import { nativeBinding } from "../dist/native-binding.js"

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")

const richAgentScript = `
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from ${JSON.stringify(sdkUrl)}

const mode = process.env.MOCK_MODE || "full"
let requireAuth = process.env.MOCK_REQUIRE_AUTH === "1"
let authenticated = !requireAuth
let currentModeId = "default"
let currentModel = "model-a"
let failLoad = process.env.MOCK_FAIL_LOAD === "1"
let activePrompt = null

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(connection => ({
  async initialize(params) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "mock-rich", title: "Mock Rich Agent", version: "1.2.3" },
      agentCapabilities: {
        loadSession: mode !== "no-load",
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [{ id: "token", name: "Token Auth", description: "Mock token auth" }],
      _meta: { clientCapsSeen: params.clientCapabilities ?? {} },
    }
  },
  async authenticate(params) {
    if (params.methodId !== "token") throw RequestError.invalidParams("bad auth method")
    authenticated = true
    return {}
  },
  async newSession() {
    if (!authenticated) throw RequestError.authRequired("need auth")
    const sessionId = "sess-new-" + Math.random().toString(36).slice(2, 8)
    // 在 newSession 返回后立即发出命令与状态通知，验证空闲期会话更新不被丢失。
    queueMicrotask(async () => {
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "compact", description: "压缩上下文" },
            { name: "plan", description: "进入计划模式", input: { hint: "计划内容" } },
          ],
        },
      })
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "session_info_update", title: "初始标题", updatedAt: "2026-11-18T00:00:00Z" },
      })
    })
    return {
      sessionId,
      modes: {
        currentModeId,
        availableModes: [
          { id: "default", name: "默认" },
          { id: "plan", name: "计划" },
        ],
      },
      models: {
        currentModelId: currentModel,
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "模型",
          type: "select",
          category: "model",
          currentValue: currentModel,
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
        },
      ],
    }
  },
  async loadSession(params) {
    if (failLoad) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "stale-partial-replay" } },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "plan", entries: [{ content: "stale-plan", priority: "high", status: "pending" }] },
      })
      throw RequestError.resourceNotFound(params.sessionId)
    }
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史用户问题" }, messageId: "h-u-1" },
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "历史思考" }, messageId: "h-a-1" },
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "h-tool-1",
        title: "历史工具",
        kind: "read",
        status: "completed",
      },
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "历史助手回答" }, messageId: "h-a-1" },
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "恢复步骤一", priority: "high", status: "completed" }],
      },
    })
    return {
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "default", name: "默认" },
          { id: "plan", name: "计划" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "模型",
          type: "select",
          category: "model",
          currentValue: "model-b",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
        },
      ],
    }
  },
  async resumeSession(params) {
    return {
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "默认" },
          { id: "plan", name: "计划" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "模型",
          type: "select",
          category: "model",
          currentValue: "model-b",
          options: [
            { value: "model-a", name: "Model A" },
            { value: "model-b", name: "Model B" },
          ],
        },
      ],
    }
  },
  async listSessions() {
    return {
      sessions: [{ sessionId: "sess-listed-1", cwd: process.cwd(), title: "已列出会话" }],
    }
  },
  async setSessionMode(params) {
    currentModeId = params.modeId
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    })
    return {}
  },
  async setSessionConfigOption(params) {
    if (params.configId === "model" && typeof params.value === "string") currentModel = params.value
    const configOptions = [
      {
        id: "model",
        name: "模型",
        type: "select",
        category: "model",
        currentValue: currentModel,
        options: [
          { value: "model-a", name: "Model A" },
          { value: "model-b", name: "Model B" },
        ],
      },
    ]
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    })
    return { configOptions }
  },
  async prompt(params) {
    const text = params.prompt.filter(b => b.type === "text").map(b => b.text).join("\\n")
    if (text.includes("trigger-rich-updates")) {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "分析需求", priority: "high", status: "in_progress" }],
        },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "markdown", id: "p-md", content: "# 执行计划" },
        },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan_update",
          plan: { type: "items", id: "p-items", entries: [{ content: "子任务", priority: "medium", status: "pending" }] },
        },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "plan_removed", id: "p-items" },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "usage_update", used: 1200, size: 128000, cost: { amount: 0.05, currency: "USD" } },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "session_info_update", title: "更新后标题" },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考中" } },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成富更新" } },
      })
      return { stopReason: "end_turn" }
    }
    if (text.includes("trigger-elicitation")) {
      const formRes = await connection.unstable_createElicitation({
        sessionId: params.sessionId,
        mode: "form",
        message: "请选择确认项",
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "string", title: "是否继续", enum: ["yes", "no"] },
          },
          required: ["confirm"],
        },
      })
      const summary = formRes.action === "accept" ? JSON.stringify(formRes.content ?? {}) : formRes.action
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "elicitation:" + summary } },
      })
      return { stopReason: "end_turn" }
    }
    if (text.includes("wait-elicitation-cancel")) {
      let cancelled = false
      activePrompt = () => { cancelled = true }
      const formPromise = connection.unstable_createElicitation({
        sessionId: params.sessionId,
        mode: "form",
        message: "等待取消的表单",
        requestedSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
        },
      })
      const res = await formPromise
      activePrompt = null
      if (cancelled || res.action === "cancel") return { stopReason: "cancelled" }
      return { stopReason: "end_turn" }
    }
    const blockKinds = params.prompt.map(b => b.type).join(",")
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "blocks:" + blockKinds } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {
    activePrompt?.()
  },
}), stream)
`

const scope = {
  accountId: "acc-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  conversationId: "conv-1",
}

const TURN_EVENT_TYPES = new Set([
  "text-delta",
  "thought-delta",
  "tool",
  "permission",
  "completed",
  "cancelled",
  "failed",
])

async function waitTurnEnd(session: { subscribe: (fn: (event: LocalAcpEvent) => void) => () => void }, run: () => void): Promise<LocalAcpEvent[]> {
  const events: LocalAcpEvent[] = []
  let unsub = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn timeout")), 10_000)
    unsub = session.subscribe(event => {
      events.push(event)
      if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  try {
    run()
    await done
    return events
  } finally {
    unsub()
  }
}

test("NativeBinding.clear 删除绑定且 write 支持原子覆盖已有绑定", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-binding-"))
  try {
    const binding = nativeBinding(dir, ["acc", "ws", "proj", "conv"])
    assert.equal(await binding.read(), undefined)
    await binding.write("sess-1")
    assert.equal(await binding.read(), "sess-1")
    await binding.write("sess-2")
    assert.equal(await binding.read(), "sess-2")
    await binding.clear()
    assert.equal(await binding.read(), undefined)

    const mem = nativeBinding(undefined, ["acc"])
    await mem.write("mem-1")
    await mem.write("mem-2")
    assert.equal(await mem.read(), "mem-2")
    await mem.clear()
    assert.equal(await mem.read(), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("会话状态解析、全量 SessionUpdate、控制方法与 subscribe() 7类事件严格隔离", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-rich-"))
  const bindingDir = await mkdtemp(join(tmpdir(), "acp-rich-bind-"))
  const host = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", richAgentScript],
    env: process.env,
  }, { bindingDirectory: bindingDir })

  try {
    const session = await host.bind(scope, workspace)
    const sessionEvents: LocalAcpSessionUpdateEvent[] = []
    const unsubSession = session.subscribeSession(ev => sessionEvents.push(ev))

    const turnEvents = await waitTurnEnd(session, () => {
      const res = session.send("trigger-rich-updates")
      assert.equal(res.status, "accepted")
    })

    // 1) subscribe() 严格只包含 7 种轮次事件且 sequence 连续 1..N
    assert.ok(turnEvents.length >= 3)
    turnEvents.forEach((ev, idx) => {
      assert.ok(TURN_EVENT_TYPES.has(ev.type), `unexpected turn event type: ${ev.type}`)
      assert.equal(ev.sequence, idx + 1)
    })
    assert.equal(turnEvents.at(-1)?.type, "completed")

    // 等微任务推送空闲期 sessionUpdate 完成
    await new Promise(r => setTimeout(r, 40))

    // 2) getState() 解析完整元数据与 SessionUpdate
    const state = session.getState()
    assert.equal(state.connected, true)
    assert.equal(state.protocolVersion, 1)
    assert.equal(state.agentInfo?.name, "mock-rich")
    assert.equal(state.agentCapabilities?.loadSession, true)
    assert.equal(state.authMethods[0]?.id, "token")
    assert.equal(state.modes?.currentModeId, "default")
    assert.equal(state.models?.currentModelId, "model-a")
    assert.equal(state.models?.availableModels.length, 2)
    assert.equal(state.configOptions[0]?.id, "model")
    assert.equal(state.availableCommands.length, 2)
    assert.equal(state.sessionInfo?.title, "更新后标题")
    assert.equal(state.usage?.used, 1200)
    assert.equal(state.usage?.cost?.currency, "USD")
    assert.equal(state.plans.some(p => p.kind === "entries" && p.entries[0]?.content === "分析需求"), true)
    assert.equal(state.plans.some(p => p.kind === "markdown" && p.id === "p-md"), true)
    assert.equal(state.plans.some(p => p.kind === "entries" && p.id === "p-items"), false)
    assert.equal(state.restoreStatus.kind, "new")

    // 3) subscribeSession 收到对应事件
    const eventTypes = new Set(sessionEvents.map(e => e.type))
    for (const expected of ["initialized", "session-opened", "plan", "available-commands", "session-info", "usage"]) {
      assert.ok(eventTypes.has(expected as LocalAcpSessionUpdateEvent["type"]), `missing session event: ${expected}`)
    }

    // 4) 空闲状态调用 setMode & setConfigOption，验证状态和空闲事件更新
    await session.setMode("plan")
    assert.equal(session.getState().currentModeId, "plan")
    await session.setConfigOption("model", "model-b")
    const modelCfg = session.getState().configOptions.find(c => c.id === "model")
    assert.equal(modelCfg?.type, "select")
    if (modelCfg?.type === "select") assert.equal(modelCfg.currentValue, "model-b")

    // 5) sendPrompt 发送多种 ContentBlock（text/resource/resource_link/image）
    const promptTurn = await waitTurnEnd(session, () => {
      const res = session.sendPrompt([
        { type: "text", text: "看附件" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "hello", mimeType: "text/plain" } },
        { type: "resource_link", uri: "file:///b.ts", name: "b.ts" },
        { type: "image", data: "AQID", mimeType: "image/png" },
      ])
      assert.equal(res.status, "accepted")
    })
    const textReply = promptTurn
      .filter((e): e is Extract<LocalAcpEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map(e => e.text)
      .join("")
    assert.equal(textReply, "blocks:text,resource,resource_link,image")

    // 6) session/list & session/resume
    const listed = await session.listSessions()
    assert.equal(listed.sessions[0]?.sessionId, "sess-listed-1")
    const resumed = await session.resumeSession("sess-listed-1")
    assert.equal(resumed.sessionId, "sess-listed-1")

    unsubSession()
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(bindingDir, { recursive: true, force: true })
  }
})

test("loadSession 回放进入 subscribeSession 而不泄漏到 subscribe()，且重开恢复可用", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-replay-"))
  const bindingDir = await mkdtemp(join(tmpdir(), "acp-replay-bind-"))
  const cmd = {
    executable: process.execPath,
    args: ["--input-type=module", "-e", richAgentScript],
    env: process.env,
  }

  try {
    // 第一次连接写入原生会话 ID
    const host1 = new LocalAcpHost(cmd, { bindingDirectory: bindingDir })
    const s1 = await host1.bind(scope, workspace)
    await waitTurnEnd(s1, () => { assert.equal(s1.send("first").status, "accepted") })
    const firstId = s1.getState().sessionId
    assert.ok(firstId)
    await host1.close()

    // 第二次重开：触发 loadSession 回放
    const host2 = new LocalAcpHost(cmd, { bindingDirectory: bindingDir })
    const s2 = await host2.bind(scope, workspace)
    const sessionEvents: LocalAcpSessionUpdateEvent[] = []
    s2.subscribeSession(ev => sessionEvents.push(ev))

    const turn2 = await waitTurnEnd(s2, () => { assert.equal(s2.send("second").status, "accepted") })
    const turnText = turn2
      .filter((e): e is Extract<LocalAcpEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map(e => e.text)
      .join("")
    // 历史回放绝不混入本轮 text-delta / tool
    assert.equal(turnText, "blocks:text")
    assert.equal(turn2.some(e => e.type === "tool"), false)

    const replayFrames = sessionEvents.filter((e): e is Extract<LocalAcpSessionUpdateEvent, { type: "replay" }> => e.type === "replay")
    assert.equal(replayFrames.length, 4)
    assert.equal(replayFrames[0]?.frame.kind, "user-text")
    assert.equal(replayFrames[1]?.frame.kind, "agent-thought")
    assert.equal(replayFrames[2]?.frame.kind, "tool")
    assert.equal(replayFrames[3]?.frame.kind, "agent-text")
    assert.equal(s2.getState().restoreStatus.kind, "restored")
    assert.equal(s2.getState().plans.length, 1)
    assert.equal(s2.getState().currentModeId, "plan")
    await host2.close()
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(bindingDir, { recursive: true, force: true })
  }
})

test("restorePolicy=fallback-new 在 loadSession 不支持或失败时清除旧绑定并回退 newSession；strict 保持报错", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-restore-"))
  const bindingDir = await mkdtemp(join(tmpdir(), "acp-restore-bind-"))

  try {
    // 预置一个旧绑定
    const hostInit = new LocalAcpHost({
      executable: process.execPath,
      args: ["--input-type=module", "-e", richAgentScript],
      env: process.env,
    }, { bindingDirectory: bindingDir })
    const sInit = await hostInit.bind(scope, workspace)
    await waitTurnEnd(sInit, () => { assert.equal(sInit.send("seed").status, "accepted") })
    const staleId = sInit.getState().sessionId!
    await hostInit.close()

    // 场景 A：Agent 不支持 loadSession + 默认 fallback-new
    const hostNoLoad = new LocalAcpHost({
      executable: process.execPath,
      args: ["--input-type=module", "-e", richAgentScript],
      env: { ...process.env, MOCK_MODE: "no-load" },
    }, { bindingDirectory: bindingDir })
    const sFallback1 = await hostNoLoad.bind(scope, workspace)
    const ev1: LocalAcpSessionUpdateEvent[] = []
    sFallback1.subscribeSession(e => ev1.push(e))
    const t1 = await waitTurnEnd(sFallback1, () => { assert.equal(sFallback1.send("after-no-load").status, "accepted") })
    assert.equal(t1.at(-1)?.type, "completed")
    const st1 = sFallback1.getState().restoreStatus
    assert.equal(st1.kind, "reset")
    if (st1.kind === "reset") {
      assert.equal(st1.reason, "session-restore-unsupported")
      assert.notEqual(st1.sessionId, staleId)
    }
    assert.equal(ev1.some(e => e.type === "session-reset" && e.reason === "session-restore-unsupported"), true)
    const replacedId = sFallback1.getState().sessionId!
    await hostNoLoad.close()

    // 场景 B：loadSession 失败 + 默认 fallback-new
    const hostFailLoad = new LocalAcpHost({
      executable: process.execPath,
      args: ["--input-type=module", "-e", richAgentScript],
      env: { ...process.env, MOCK_FAIL_LOAD: "1" },
    }, { bindingDirectory: bindingDir })
    const sFallback2 = await hostFailLoad.bind(scope, workspace)
    const ev2: LocalAcpSessionUpdateEvent[] = []
    sFallback2.subscribeSession(e => ev2.push(e))
    const t2 = await waitTurnEnd(sFallback2, () => { assert.equal(sFallback2.send("after-fail-load").status, "accepted") })
    assert.equal(t2.at(-1)?.type, "completed")
    const st2 = sFallback2.getState().restoreStatus
    assert.equal(st2.kind, "reset")
    if (st2.kind === "reset") {
      assert.equal(st2.reason, "session-restore-failed")
      assert.equal(st2.previousSessionId, replacedId)
    }
    assert.equal(ev2.some(e => e.type === "session-reset" && e.reason === "session-restore-failed"), true)
    assert.equal(ev2.some(e => e.type === "replay"), false)
    assert.equal(sFallback2.getState().plans.length, 0)
    await hostFailLoad.close()

    // 场景 C：restorePolicy="strict" 保留原有 RestoreError
    const hostStrict = new LocalAcpHost({
      executable: process.execPath,
      args: ["--input-type=module", "-e", richAgentScript],
      env: { ...process.env, MOCK_MODE: "no-load" },
    }, { bindingDirectory: bindingDir, restorePolicy: "strict" })
    const sStrict = await hostStrict.bind(scope, workspace)
    const tStrict = await waitTurnEnd(sStrict, () => { assert.equal(sStrict.send("strict").status, "accepted") })
    assert.deepEqual(
      tStrict.at(-1),
      { turnId: tStrict[0]!.turnId, sequence: 1, type: "failed", reason: "session-restore-unsupported" },
    )
    await hostStrict.close()
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(bindingDir, { recursive: true, force: true })
  }
})

test("authenticate 支持在需认证 Agent 上先认证再建会话", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-auth-"))
  const host = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", richAgentScript],
    env: { ...process.env, MOCK_REQUIRE_AUTH: "1" },
  })
  try {
    const session = await host.bind(scope, workspace)
    await session.authenticate("token")
    assert.equal(session.getState().authMethods[0]?.id, "token")
    const events = await waitTurnEnd(session, () => {
      assert.equal(session.send("after-auth").status, "accepted")
    })
    assert.equal(events.at(-1)?.type, "completed")
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("enableElicitation 默认关闭；开启后声明能力、派发表单、支持回答并在 cancel/close 时取消", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-elicit-"))
  // 1) 默认关闭：调用 elicitation 会失败（agent 收到 -32601）
  const hostDefault = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", richAgentScript],
    env: process.env,
  })
  try {
    const sDefault = await hostDefault.bind(scope, workspace)
    const tDefault = await waitTurnEnd(sDefault, () => {
      assert.equal(sDefault.send("trigger-elicitation").status, "accepted")
    })
    assert.equal(tDefault.at(-1)?.type, "failed")
  } finally {
    await hostDefault.close()
  }

  // 2) 开启 enableElicitation: true：正常作答 + cancel() 取消
  const hostEnabled = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", richAgentScript],
    env: process.env,
  }, { enableElicitation: true })
  try {
    const session = await hostEnabled.bind(scope, workspace)
    const seenRequests: string[] = []
    session.subscribeSession(ev => {
      if (ev.type === "elicitation" && ev.request) {
        seenRequests.push(ev.request.id)
        if (ev.request.message === "请选择确认项") {
          assert.equal(session.answerElicitation(ev.request.id, { action: "accept", content: { confirm: "yes" } }), true)
        }
      }
    })
    const t1 = await waitTurnEnd(session, () => {
      assert.equal(session.send("trigger-elicitation").status, "accepted")
    })
    const text1 = t1.filter((e): e is Extract<LocalAcpEvent, { type: "text-delta" }> => e.type === "text-delta").map(e => e.text).join("")
    assert.equal(text1, 'elicitation:{"confirm":"yes"}')

    // 取消挂起中的表单
    let activeTurnId = ""
    let cancelledOnSession = false
    const unsubCancel = session.subscribeSession(ev => {
      if (ev.type === "elicitation" && ev.request && ev.request.message === "等待取消的表单") {
        assert.equal(session.cancel(activeTurnId), true)
      }
      if (ev.type === "elicitation" && ev.request === null) {
        cancelledOnSession = true
      }
    })
    const t2 = await waitTurnEnd(session, () => {
      const res = session.send("wait-elicitation-cancel")
      assert.equal(res.status, "accepted")
      if (res.status === "accepted") activeTurnId = res.turnId
    })
    unsubCancel()
    assert.equal(t2.at(-1)?.type, "cancelled")
    assert.equal(cancelledOnSession, true)
    assert.equal(seenRequests.length, 2)

    // close() 在表单挂起期间安全结束轮次并回收子进程
    const closeObserved = new Promise<LocalAcpEvent>(resolveClose => {
      const unsubTurn = session.subscribe(ev => {
        if (ev.type === "failed" || ev.type === "completed" || ev.type === "cancelled") {
          unsubTurn()
          resolveClose(ev)
        }
      })
    })
    const closeTriggered = new Promise<void>(resolveTrigger => {
      const unsubReq = session.subscribeSession(ev => {
        if (ev.type === "elicitation" && ev.request && ev.request.message === "等待取消的表单") {
          unsubReq()
          void hostEnabled.close().then(resolveTrigger)
        }
      })
    })
    assert.equal(session.send("wait-elicitation-cancel").status, "accepted")
    const [terminalOnClose] = await Promise.all([closeObserved, closeTriggered])
    assert.deepEqual(
      { type: terminalOnClose.type, reason: terminalOnClose.type === "failed" ? terminalOnClose.reason : undefined },
      { type: "failed", reason: "session-closed" },
    )
  } finally {
    await hostEnabled.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
