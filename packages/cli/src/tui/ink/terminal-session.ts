/** Ink 全屏会话的终端控制 owner：进入 alternate screen，并保证退出时恢复 Shell。 */

const ALTERNATE_SCREEN_ENTER = "\u001b[?1049h"
const CLEAR_AND_HOME = "\u001b[2J\u001b[H"
const CURSOR_HIDE = "\u001b[?25l"
const CURSOR_SHOW = "\u001b[?25h"
const MOUSE_SGR_ENABLE = "\u001b[?1000h\u001b[?1006h"
const MOUSE_SGR_DISABLE = "\u001b[?1006l\u001b[?1000l"
const ALTERNATE_SCREEN_EXIT = "\u001b[?1049l"

/** TerminalSession 可发布给 Ink 根的事件。 */
export type TerminalSessionEvent =
  | { type: "resize"; columns: number; rows: number }
  | { type: "wheel"; direction: "up" | "down"; steps: number }

/** 只声明会话需要的 stdin 能力，避免接管 Ink 的 raw mode 或 readable 事件。 */
export type TerminalSessionInput = {
  readonly isTTY?: boolean
}

/** 只声明会话需要的 stdout 能力，便于用 fake stream 测试终端恢复。 */
export type TerminalSessionOutput = {
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  write(chunk: string): unknown
  on(event: "resize", listener: () => void): unknown
  off(event: "resize", listener: () => void): unknown
}

/** TerminalSession 的注入依赖。 */
export type TerminalSessionDependencies = {
  readonly stdin: TerminalSessionInput
  readonly stdout: TerminalSessionOutput
}

/** SGR 滚轮序列的纯解析结果。 */
export type MouseWheelEvent = Extract<TerminalSessionEvent, { type: "wheel" }>

const SGR_MOUSE_WHEEL_GLOBAL = /(?:\u001b)?\[<([0-9]+);([0-9]+);([0-9]+)M/g

/** 解析单条或多条连发的 SGR wheel 64/65 报告；计算净滚轮方向和总 steps。 */
export function parseMouseWheelInput(input: string): MouseWheelEvent | undefined {
  if (!input) return undefined
  if (!/^(?:\u001b)?\[<[0-9]/.test(input)) return undefined

  let up = 0
  let down = 0
  let match: RegExpExecArray | null
  SGR_MOUSE_WHEEL_GLOBAL.lastIndex = 0

  while ((match = SGR_MOUSE_WHEEL_GLOBAL.exec(input)) !== null) {
    const button = Number(match[1])
    const columns = Number(match[2])
    const rows = Number(match[3])
    if (
      Number.isSafeInteger(button)
      && Number.isSafeInteger(columns)
      && Number.isSafeInteger(rows)
      && columns >= 1
      && rows >= 1
    ) {
      if (button === 64) up += 1
      else if (button === 65) down += 1
    }
  }

  const net = up - down
  if (net > 0) return { type: "wheel", direction: "up", steps: net }
  if (net < 0) return { type: "wheel", direction: "down", steps: -net }
  return undefined
}

type SessionState = "new" | "active" | "closed"

function dimension(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 管理全屏终端控制码、resize 监听和幂等恢复。 */
export class TerminalSession {
  private readonly stdin: TerminalSessionInput
  private readonly stdout: TerminalSessionOutput
  private readonly listeners = new Set<(event: TerminalSessionEvent) => void>()
  private readonly onResize = () => {
    if (this.state !== "active") return
    const event: TerminalSessionEvent = {
      type: "resize",
      columns: dimension(this.stdout.columns),
      rows: dimension(this.stdout.rows),
    }
    for (const listener of [...this.listeners]) listener(event)
  }
  private state: SessionState = "new"
  private alternateScreenEntered = false
  private cursorHidden = false
  private mouseReportingEnabled = false
  private resizeListenerInstalled = false

  constructor(dependencies: TerminalSessionDependencies) {
    this.stdin = dependencies.stdin
    this.stdout = dependencies.stdout
  }

  /** 进入全屏终端；非 TTY 或重复进入时保持 no-op。 */
  enter(): void {
    if (this.state !== "new") return
    if (this.stdin.isTTY !== true || this.stdout.isTTY !== true) {
      this.state = "closed"
      this.listeners.clear()
      return
    }

    try {
      this.write(ALTERNATE_SCREEN_ENTER)
      this.alternateScreenEntered = true
      this.write(CLEAR_AND_HOME)
      this.write(CURSOR_HIDE)
      this.cursorHidden = true
      this.write(MOUSE_SGR_ENABLE)
      this.mouseReportingEnabled = true
      this.stdout.on("resize", this.onResize)
      this.resizeListenerInstalled = true
      this.state = "active"
    } catch (error) {
      this.state = "closed"
      this.restore()
      throw error
    }
  }

  /** 订阅 resize/wheel 语义事件，并返回幂等取消函数。 */
  subscribe(listener: (event: TerminalSessionEvent) => void): () => void {
    if (this.state === "closed") return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 恢复鼠标、光标、alternate screen 与监听器；重复调用不会重复写控制码。 */
  close(): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.restore()
  }

  private write(sequence: string): void {
    this.stdout.write(sequence)
  }

  private restore(): void {
    this.listeners.clear()
    if (this.resizeListenerInstalled) {
      this.resizeListenerInstalled = false
      try {
        this.stdout.off("resize", this.onResize)
      } catch {
        // 终端恢复继续执行，不能让一个 listener 清理错误掩盖其它恢复步骤。
      }
    }
    if (this.mouseReportingEnabled) {
      this.mouseReportingEnabled = false
      try {
        this.write(MOUSE_SGR_DISABLE)
      } catch {
        // close 必须幂等且不抛出二次恢复错误。
      }
    }
    if (this.cursorHidden) {
      this.cursorHidden = false
      try {
        this.write(CURSOR_SHOW)
      } catch {
        // close 必须继续尝试退出 alternate screen。
      }
    }
    if (this.alternateScreenEntered) {
      this.alternateScreenEntered = false
      try {
        this.write(ALTERNATE_SCREEN_EXIT)
      } catch {
        // 原始运行错误优先于终端恢复错误。
      }
    }
  }
}

/** 创建注入终端流的全屏会话。 */
export function createTerminalSession(dependencies: TerminalSessionDependencies): TerminalSession {
  return new TerminalSession(dependencies)
}
