/** Ink TUI 与 Web handoff 测试：验证 web-active 冻结、恢复补齐 delta 与输入租约。 */
/** @jsxImportSource react */
import React from "react"
import { describe, expect, it } from "vitest"
import { render } from "ink"
import { PassThrough } from "node:stream"

import {
  createPresentationCoordinator,
  type GatewayChannel,
  type PresentationServer,
  type WebUiServerMessage,
} from "../../src/presentation-coordinator"
import { AsyncQueue } from "../../src/ipc/transport"
import { createTuiAdapter } from "../../src/tui/application/adapter"
import { InkConversationRoot } from "../../src/tui/ink/app"
import { makeHarness } from "../interactive/harness"

class FakeServer implements PresentationServer {
  readonly origin = "http://127.0.0.1:8123"
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  pathFor(handoffId: string): string {
    return `/web/h/${handoffId}`
  }
}

class FakeChannel implements GatewayChannel {
  readonly messages = new AsyncQueue<unknown>()
  readonly sent: WebUiServerMessage[] = []
  closed = false

  async send(message: WebUiServerMessage): Promise<void> {
    this.sent.push(message)
  }

  async close(): Promise<void> {
    this.closed = true
    this.messages.end()
  }

  isOpen(): boolean {
    return !this.closed
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe("Ink Web Handoff", () => {
  it("web-active 期间冻结时间线更新并显示接管提示；返回后一次性补齐 delta 且保留草稿", async () => {
    const harness = makeHarness()
    const controller = harness.controller
    const server = new FakeServer()
    let openedUrl = ""

    const coordinator = createPresentationCoordinator({
      server,
      openBrowser: async url => {
        openedUrl = url
      },
      dispatch: intent => controller.dispatch(intent),
      onRendererConnected: () => {},
    })

    const adapter = createTuiAdapter({
      controller,
      onRequestExit: () => {},
      dispatchGate: intent => coordinator.tuiDispatch(intent),
    })

    // 初始草稿
    void adapter.dispatch({ type: "draft-input", value: "保留草稿", cursorOffset: 4 })

    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => {
      output += chunk.toString()
    })

    const instance = render(
      <InkConversationRoot adapter={adapter} webHandoff={coordinator} />,
      { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false },
    )
    await waitFor(() => output.includes("保留草稿"))

    expect(output).toContain("保留草稿")
    expect(output).not.toContain("已移交 Web 工作台")

    // 启动 Web handoff（opening-web 阶段）
    await coordinator.open()
    expect(coordinator.getSnapshot().phase).toBe("opening-web")
    expect(output).not.toContain("已移交 Web 工作台")

    // Browser 连入并 ready -> web-active 阶段
    const channel = new FakeChannel()
    const snapshot = coordinator.getSnapshot()
    if (snapshot.phase !== "opening-web") throw new Error("expected opening-web")
    const token = new URL(openedUrl).hash.slice("#ui=".length)
    await coordinator.attachRenderer(snapshot.handoffId, token, channel)
    coordinator.requestReady()
    expect(coordinator.getSnapshot().phase).toBe("web-active")

    // 验证：显示接管提示
    await waitFor(() => output.includes("已移交 Web 工作台"))
    expect(output).toContain("已移交 Web 工作台")

    const outputSnapshotAtTakeover = output

    // 在 Web 接管期间，Web 端提交新消息进入 controller
    await controller.dispatch({ type: "input.submit", value: "Web端提交的新消息" })
    await new Promise(resolve => setImmediate(resolve))

    // 验证：web-active 期间时间线冻结，终端不向用户刷出中间消息
    const deltaOutput = output.slice(outputSnapshotAtTakeover.length)
    expect(deltaOutput).not.toContain("Web端提交的新消息")

    // 验证：期间向 TUI dispatch 提交消息被租约拒绝
    const outcome = await coordinator.tuiDispatch({ type: "input.submit", value: "不该被受理" })
    expect(outcome.status).toBe("rejected")

    // 浏览器返回终端 -> returning-tui -> tui-active
    coordinator.requestReturn()
    expect(coordinator.getSnapshot().phase).toBe("tui-active")
    await waitFor(() => output.includes("Web端提交的新消息"))

    // 验证：Web 期间的消息一次性补齐显示在终端
    expect(output).toContain("Web端提交的新消息")
    // 草稿依然保留
    expect(output).toContain("保留草稿")

    instance.unmount()
    await coordinator.close()
  })

  it("在 web-active 期间按 Ctrl+C 触发 requestReturn 恢复终端", async () => {
    const harness = makeHarness()
    const controller = harness.controller
    const server = new FakeServer()
    let openedUrl = ""

    const coordinator = createPresentationCoordinator({
      server,
      openBrowser: async url => {
        openedUrl = url
      },
      dispatch: intent => controller.dispatch(intent),
      onRendererConnected: () => {},
    })

    const adapter = createTuiAdapter({
      controller,
      onRequestExit: () => {},
      dispatchGate: intent => coordinator.tuiDispatch(intent),
    })

    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => {
      output += chunk.toString()
    })

    const instance = render(
      <InkConversationRoot adapter={adapter} webHandoff={coordinator} />,
      { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false },
    )

    await coordinator.open()
    const channel = new FakeChannel()
    const snapshot = coordinator.getSnapshot()
    if (snapshot.phase !== "opening-web") throw new Error("expected opening-web")
    const token = new URL(openedUrl).hash.slice("#ui=".length)
    await coordinator.attachRenderer(snapshot.handoffId, token, channel)
    coordinator.requestReady()
    expect(coordinator.getSnapshot().phase).toBe("web-active")

    await waitFor(() => output.includes("已移交 Web 工作台"))

    // 在终端输入 Ctrl+C (\x03)
    stdin.write("\x03")
    await waitFor(() => coordinator.getSnapshot().phase === "tui-active")
    expect(coordinator.getSnapshot().phase).toBe("tui-active")

    instance.unmount()
    await coordinator.close()
  })

  it("opening-web 超时自动收敛回 tui-active", async () => {
    const harness = makeHarness()
    const controller = harness.controller
    const server = new FakeServer()

    const coordinator = createPresentationCoordinator({
      server,
      openBrowser: async () => {},
      dispatch: intent => controller.dispatch(intent),
      onRendererConnected: () => {},
      readyTimeoutMs: 50,
    })

    await coordinator.open()
    expect(coordinator.getSnapshot().phase).toBe("opening-web")

    await waitFor(() => coordinator.getSnapshot().phase === "tui-active", 500)
    expect(coordinator.getSnapshot().phase).toBe("tui-active")

    await coordinator.close()
  })

  it("第二窗口连接使用旧 token 无法通过验证", async () => {
    const harness = makeHarness()
    const controller = harness.controller
    const server = new FakeServer()
    let openedUrl = ""

    const coordinator = createPresentationCoordinator({
      server,
      openBrowser: async url => {
        openedUrl = url
      },
      dispatch: intent => controller.dispatch(intent),
      onRendererConnected: () => {},
    })

    await coordinator.open()
    const snapshot = coordinator.getSnapshot()
    if (snapshot.phase !== "opening-web") throw new Error("expected opening-web")
    const token = new URL(openedUrl).hash.slice("#ui=".length)

    // 第一次验证：有效
    expect(coordinator.validateUiToken(snapshot.handoffId, token, server.origin)).toBe(true)

    // 连接并消费 token
    const channel = new FakeChannel()
    await coordinator.attachRenderer(snapshot.handoffId, token, channel)

    // 第二个窗口使用已经被消费的 bootstrap token，验证失败（单窗口/防重放）
    expect(coordinator.validateUiToken(snapshot.handoffId, token, server.origin)).toBe(false)

    await coordinator.close()
  })
})
