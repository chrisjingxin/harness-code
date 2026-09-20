/** TerminalSession 的终端控制序列、恢复和滚轮解析测试。 */

import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"

import {
  createTerminalSession,
  parseMouseWheelInput,
  type TerminalSessionOutput,
} from "../../src/tui/ink/terminal-session"

class FakeStdout extends EventEmitter implements TerminalSessionOutput {
  isTTY = true
  columns = 80
  rows = 24
  readonly writes: string[] = []
  failAtWrite?: number
  private writeCount = 0

  write(chunk: string): boolean {
    this.writeCount += 1
    if (this.writeCount === this.failAtWrite) throw new Error("write failed")
    this.writes.push(chunk)
    return true
  }
}

function ttyStdin() {
  return {
    isTTY: true,
    setRawMode: () => { throw new Error("TerminalSession must not own raw mode") },
  }
}

describe("TerminalSession", () => {
  it("enters the alternate screen and reverses terminal controls on close", () => {
    const stdout = new FakeStdout()
    const session = createTerminalSession({ stdin: ttyStdin(), stdout })

    session.enter()
    session.close()

    expect(stdout.writes).toEqual([
      "\u001b[?1049h",
      "\u001b[2J\u001b[H",
      "\u001b[?25l",
      "\u001b[?1000h\u001b[?1006h",
      "\u001b[?1006l\u001b[?1000l",
      "\u001b[?25h",
      "\u001b[?1049l",
    ])
  })

  it.each([
    [1, []],
    [2, ["\u001b[?1049h", "\u001b[?1049l"]],
    [3, ["\u001b[?1049h", "\u001b[2J\u001b[H", "\u001b[?1049l"]],
    [4, ["\u001b[?1049h", "\u001b[2J\u001b[H", "\u001b[?25l", "\u001b[?25h", "\u001b[?1049l"]],
  ])("reverses only completed controls when enter fails at write %s", (failAtWrite, expectedWrites) => {
    const stdout = new FakeStdout()
    stdout.failAtWrite = failAtWrite as number
    const session = createTerminalSession({ stdin: ttyStdin(), stdout })

    expect(() => session.enter()).toThrow("write failed")
    expect(stdout.writes).toEqual(expectedWrites)
  })

  it("makes close idempotent after a successful enter", () => {
    const stdout = new FakeStdout()
    const session = createTerminalSession({ stdin: ttyStdin(), stdout })

    session.enter()
    session.close()
    session.close()

    expect(stdout.writes.filter(value => value === "\u001b[?1049l")).toHaveLength(1)
    expect(stdout.listenerCount("resize")).toBe(0)
  })

  it("does not emit controls or subscribe to resize for a non-TTY", () => {
    const stdout = new FakeStdout()
    stdout.isTTY = false
    const session = createTerminalSession({ stdin: ttyStdin(), stdout })

    session.enter()
    session.close()

    expect(stdout.writes).toEqual([])
    expect(stdout.listenerCount("resize")).toBe(0)
  })

  it("publishes resize dimensions and removes the listener on unsubscribe or close", () => {
    const stdout = new FakeStdout()
    const session = createTerminalSession({ stdin: ttyStdin(), stdout })
    const events: unknown[] = []
    const unsubscribe = session.subscribe(event => events.push(event))

    session.enter()
    stdout.columns = 120
    stdout.rows = 40
    stdout.emit("resize")
    unsubscribe()
    stdout.columns = 72
    stdout.rows = 24
    stdout.emit("resize")
    session.close()

    expect(events).toEqual([{ type: "resize", columns: 120, rows: 40 }])
    expect(stdout.listenerCount("resize")).toBe(0)
  })
})

describe("parseMouseWheelInput", () => {
  it("parses SGR wheel up and down reports", () => {
    expect(parseMouseWheelInput("\u001b[<64;12;8M")).toEqual({ type: "wheel", direction: "up", steps: 1 })
    expect(parseMouseWheelInput("[<64;12;8M")).toEqual({ type: "wheel", direction: "up", steps: 1 })
    expect(parseMouseWheelInput("\u001b[<65;12;8M")).toEqual({ type: "wheel", direction: "down", steps: 1 })
    expect(parseMouseWheelInput("[<65;49;44M[<64;49;44M[<64;49;44M[<64;49;44M[<65;49;42M[")).toEqual({
      type: "wheel",
      direction: "up",
      steps: 1,
    })
    expect(parseMouseWheelInput("[<64;10;10M[<64;10;10M[<64;10;10M")).toEqual({
      type: "wheel",
      direction: "up",
      steps: 3,
    })
  })

  it("ignores non-wheel, malformed, partial and release reports", () => {
    expect(parseMouseWheelInput("\u001b[<0;12;8M")).toBeUndefined()
    expect(parseMouseWheelInput("\u001b[<1;12;8M")).toBeUndefined()
    expect(parseMouseWheelInput("\u001b[<64;12;8")).toBeUndefined()
    expect(parseMouseWheelInput("\u001b[<64;x;8M")).toBeUndefined()
    expect(parseMouseWheelInput("\u001b[<64;0;0M")).toBeUndefined()
    expect(parseMouseWheelInput("\u001b[<64;12;8m")).toBeUndefined()
    expect(parseMouseWheelInput("text\u001b[<64;12;8M")).toBeUndefined()
  })
})
