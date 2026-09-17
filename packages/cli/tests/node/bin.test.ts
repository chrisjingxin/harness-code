/** Node CLI 入口的版本门禁与动态加载行为。 */
import { describe, expect, it, vi } from "vitest"

import { assertSupportedNode, formatCliError, isDirectEntry, runCli } from "../../src/bin"

describe("Node CLI bootstrap", () => {
  it("rejects Node 19 before loading the application", async () => {
    const load = vi.fn()

    await expect(runCli([], { nodeVersion: "19.9.0", load })).rejects.toThrow("Node.js >=20")
    expect(load).not.toHaveBeenCalled()
  })

  it("accepts all Node major versions from 20 onward", () => {
    expect(() => assertSupportedNode("20.0.0")).not.toThrow()
    expect(() => assertSupportedNode("22.12.0")).not.toThrow()
    expect(() => assertSupportedNode("24.0.0")).not.toThrow()
  })

  it("passes argv to the application after the version gate", async () => {
    const main = vi.fn(async () => undefined)

    await runCli(["--version"], { nodeVersion: "20.0.0", load: async () => ({ main }) })

    expect(main).toHaveBeenCalledWith(["--version"])
  })

  it("preserves the stable Thread Store migration diagnostic code", () => {
    const error = Object.assign(new Error("THREAD_STORE_UNAVAILABLE"), {
      data: { code: "CHECKPOINT_MIGRATION_LOCK_UNAVAILABLE" },
    })

    expect(formatCliError(error)).toBe("THREAD_STORE_UNAVAILABLE: CHECKPOINT_MIGRATION_LOCK_UNAVAILABLE")
    expect(formatCliError(new Error("plain failure"))).toBe("plain failure")
  })

  it("recognizes an npm bin symlink as the direct entry", () => {
    const realpath = (path: string) => path === "/install/node_modules/.bin/harness"
      ? "/install/node_modules/@za38/cli/dist/index.js"
      : path

    expect(isDirectEntry(
      "/install/node_modules/.bin/harness",
      "/install/node_modules/@za38/cli/dist/index.js",
      realpath,
    )).toBe(true)
  })
})
