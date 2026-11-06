/** 子进程跑 `browserBundle()` 的测试 helper。

 * 【为什么要在子进程里跑】`bun test` 全量并行时测试进程自身 fd 争用，进程内
 * `Bun.build` 会稳定报 `Unseekable reading file`；子进程有独立 fd 预算，构建
 * 不受影响。产物经 stdout JSON 回传，形状与 `browserBundle()` 一致。
 */

import type { browserBundle } from "../../src/acp-web/bundle"

export type BrowserAssetsResult = Awaited<ReturnType<typeof browserBundle>>

export async function buildBrowserAssetsInSubprocess(): Promise<BrowserAssetsResult> {
  const proc = Bun.spawn(
    ["bun", "-e",
      'import { browserBundle } from "./src/acp-web/bundle";' +
      'const a = await browserBundle(); process.stdout.write(JSON.stringify(a))'],
    // tests/acp-web/support → ../../.. = packages/cli，子进程以包根为 cwd 才能解析相对导入。
    { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`browserBundle 子进程构建失败(${code}): ${err.slice(-400)}`)
  return JSON.parse(out) as BrowserAssetsResult
}
