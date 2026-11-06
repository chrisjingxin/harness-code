/**
 * 浏览器 bundle 边界检查：把各入口单独打包为 target:"browser"，
 * 断言 metafile 输入里没有任何 `node:` 模块。
 *
 * 实现走 `bun build --metafile` CLI（设计 R15 的兜底路径）：Bun.build
 * 的 JS API 在 bun test 里对 `../ext` 这类父级导入解析失败，CLI 正常。
 * metafile 不存在时用例必须失败而不是静默通过（R15）——没有它就没法
 * 证明"浏览器侧零 Node 依赖"。
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PACKAGE = join(import.meta.dir, "../..")

async function bundleInputs(relEntry: string): Promise<{ inputs: string[]; nodeImports: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "acp-bundle-"))
  const metaPath = join(dir, "meta.json")
  const proc = Bun.spawn(
    [process.execPath, "build", `src/${relEntry}`, "--target", "browser", "--outdir", dir, `--metafile=${metaPath}`],
    { cwd: PACKAGE, stdout: "ignore", stderr: "pipe" },
  )
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (exitCode !== 0) throw new Error(`bun build 失败: ${stderr.slice(0, 400)}`)
  let meta: { inputs: Record<string, unknown> }
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"))
  } catch {
    throw new Error("bun build 没有产出 metafile，无法检查 node: 空桩")
  }
  const inputs = Object.keys(meta.inputs)
  return { inputs, nodeImports: inputs.filter(key => key.startsWith("node:")) }
}

describe("浏览器 bundle 零 node:", () => {
  test("src/interactive/controller.ts 打包后无任何 node: 输入", async () => {
    const { nodeImports } = await bundleInputs("interactive/controller.ts")
    expect(nodeImports).toEqual([])
  })

  test("src/acp-web/client/ws-stream.ts 打包后无任何 node: 输入", async () => {
    const { inputs, nodeImports } = await bundleInputs("acp-web/client/ws-stream.ts")
    expect(nodeImports).toEqual([])
    // SDK 的 Stream/AnyMessage 只作类型导入：运行时代码里不应有 SDK 模块。
    expect(inputs.some(key => key.includes("@agentclientprotocol"))).toBe(false)
  })

  test("src/acp-web/client/acp-agent-gateway.ts 打包后无任何 node: 输入（含 SDK 与 zod）", async () => {
    const { nodeImports } = await bundleInputs("acp-web/client/acp-agent-gateway.ts")
    expect(nodeImports).toEqual([])
  })
})
