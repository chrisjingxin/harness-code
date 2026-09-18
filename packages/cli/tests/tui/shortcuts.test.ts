/** 快捷键唯一 owner：Interaction / 临时视图 / 菜单优先于 InputBar，主时间线不再滚动。 */
import { describe, expect, it } from "vitest"

import { resolveShortcut } from "../../src/tui/application/shortcuts"
import { resolveInkInput } from "../../src/tui/ink/app"

const idle = {
  commandMenuVisible: false,
  commandOptionCount: 0,
  activeRun: false,
  hasDraft: false,
}

const emptyKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, home: false, end: false, return: false,
  escape: false, ctrl: false, shift: false, tab: false, backspace: false,
  delete: false, meta: false, super: false, hyper: false, capsLock: false,
  numLock: false,
}

describe("shortcut owner priority", () => {
  it("clears draft before cancelling a run on Ctrl+C", () => {
    expect(resolveShortcut({ name: "c", ctrl: true }, { ...idle, hasDraft: true, activeRun: true })).toBe("clear-draft")
    expect(resolveShortcut({ name: "c", ctrl: true }, { ...idle, hasDraft: false, activeRun: true })).toBe("cancel-run")
    expect(resolveShortcut({ name: "c", ctrl: true }, idle)).toBe("exit")
  })

  it("lets a pending interaction consume Enter/Esc/Tab so InputBar does not see them", () => {
    const ctx = { ...idle, interactionActive: true, hasDraft: true, commandMenuVisible: true, commandOptionCount: 2 }
    expect(resolveShortcut({ name: "return", ctrl: false }, ctx)).toBe("none")
    expect(resolveShortcut({ name: "escape", ctrl: false }, ctx)).toBe("none")
    expect(resolveShortcut({ name: "tab", ctrl: false }, ctx)).toBe("none")
    expect(resolveShortcut({ name: "c", ctrl: true }, ctx)).toBe("clear-draft")
  })

  it("closes the current temporary view before menus or InputBar handle Esc", () => {
    const workspace = { ...idle, temporaryViewKind: "workspace" as const, commandMenuVisible: true, commandOptionCount: 2 }
    expect(resolveShortcut({ name: "escape", ctrl: false }, workspace)).toBe("close-temporary-view")
    expect(resolveShortcut({ name: "return", ctrl: false }, { ...idle, temporaryViewKind: "status" })).toBe("close-temporary-view")
    expect(resolveShortcut({ name: "q", ctrl: false }, { ...idle, temporaryViewKind: "inspect" })).toBe("close-temporary-view")
    expect(resolveShortcut({ name: "c", ctrl: false }, { ...idle, temporaryViewKind: "btw" })).toBe("copy-btw-answer")
  })

  it("does not give conversation history a scroll owner", () => {
    expect(resolveShortcut({ name: "pageup", ctrl: false }, idle)).toBe("none")
    expect(resolveShortcut({ name: "pagedown", ctrl: false }, { ...idle, hasDraft: true })).toBe("none")
    expect(resolveShortcut({ name: "up", ctrl: true }, { ...idle, activeRun: true })).toBe("none")
    expect(resolveShortcut({ name: "home", ctrl: true }, idle)).toBe("none")
  })

  it("opens workspace with Ctrl+B and the tool inspector with Ctrl+O", () => {
    expect(resolveShortcut({ name: "b", ctrl: true }, idle)).toBe("open-workspace")
    expect(resolveShortcut({ name: "o", ctrl: true }, idle)).toBe("open-tool-inspector")
    expect(resolveShortcut({ name: "escape", ctrl: false }, { ...idle, activeRun: true })).toBe("hint-interrupt")
  })

  it("keeps command-menu Enter from reaching InputBar submit", () => {
    const menu = { ...idle, commandMenuVisible: true, commandOptionCount: 2, hasDraft: true }
    expect(resolveShortcut({ name: "return", ctrl: false }, menu)).toBe("command-select")
    expect(resolveInkInput("", { ...emptyKey, return: true }, {
      hasDraft: true,
      activeRun: false,
      commandMenuVisible: true,
      commandOptionCount: 2,
    })).toEqual({ type: "shortcut", action: "command-select" })
  })
})
