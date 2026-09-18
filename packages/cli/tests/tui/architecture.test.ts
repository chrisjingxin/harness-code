/** TUI Adapter 与快捷键模块不得泄漏 OpenTUI/Ink 类型或已取消的滚动/鼠标/侧栏契约。 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { createTuiAdapter } from "../../src/tui/application/adapter"
import { makeHarness } from "../interactive/harness"

const here = dirname(fileURLToPath(import.meta.url))
const adapterSource = readFileSync(resolve(here, "../../src/tui/application/adapter.ts"), "utf8")
const shortcutSource = readFileSync(resolve(here, "../../src/tui/application/shortcuts.ts"), "utf8")
const presentationTypes = readFileSync(resolve(here, "../../src/tui/presentation/types.ts"), "utf8")
const inkAppSource = readFileSync(resolve(here, "../../src/tui/ink/app.tsx"), "utf8")

describe("TuiAdapter seam", () => {
  it("keeps adapter, shortcuts, and presentation types free of renderer objects", () => {
    const combined = `${adapterSource}\n${shortcutSource}\n${presentationTypes}`
    expect(combined).not.toMatch(/@opentui/)
    expect(combined).not.toMatch(/KeyEvent|TextareaRenderable|ScrollBoxRenderable/)
    expect(inkAppSource).not.toMatch(/@opentui/)
  })

  it("drops conversation scroll, hover, and sidebar layout from the public contract", () => {
    expect(adapterSource).not.toMatch(/scrollRequest/)
    expect(adapterSource).not.toMatch(/sidebar-toggle|sidebar-focus-switch|sidebar-tab-switch/)
    expect(adapterSource).not.toMatch(/command-menu-hover|mention-menu-hover|picker-hover/)
    expect(adapterSource).not.toMatch(/file-preview-scroll/)
    expect(adapterSource).not.toMatch(/readonly sidebar:/)
    expect(shortcutSource).not.toMatch(/scroll-line-up|scroll-page-up/)
  })

  it("exposes workspace and tool-inspector temporary-view intents", () => {
    expect(adapterSource).toMatch(/workspace-open/)
    expect(adapterSource).toMatch(/workspace-navigate/)
    expect(adapterSource).toMatch(/temporary-view-close/)
    expect(adapterSource).toMatch(/tool-inspector-open/)
  })

  it("projects workspace and inspector as exclusive temporary views", async () => {
    const harness = makeHarness()
    const adapter = createTuiAdapter({ controller: harness.controller, onRequestExit: () => {} })
    try {
      const initial = adapter.getSnapshot()
      expect(initial).not.toHaveProperty("scrollRequest")
      expect(initial).not.toHaveProperty("sidebar")
      expect(initial.temporaryView.kind).toBe("none")

      await adapter.dispatch({ type: "workspace-open" })
      expect(adapter.getSnapshot().temporaryView.kind).toBe("workspace")
      expect(adapter.getSnapshot().workspace.fileTree).toEqual(expect.objectContaining({
        status: expect.stringMatching(/idle|loading|ready|error/),
        rows: expect.any(Array),
      }))

      await adapter.dispatch({ type: "tool-inspector-open" })
      expect(adapter.getSnapshot().temporaryView.kind).toBe("tool-inspector")

      await adapter.dispatch({ type: "temporary-view-close" })
      expect(adapter.getSnapshot().temporaryView.kind).toBe("none")
    } finally {
      await adapter.close()
      await harness.controller.close()
    }
  })
})
