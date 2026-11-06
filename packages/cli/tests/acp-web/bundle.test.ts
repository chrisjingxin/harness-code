/**
 * ACP Web 浏览器资产：源码模式即时构建出真实脚本（含 `/acp/boot` 与
 * `/acp/ws` 字面量）；HTML 引用的三个资源名都在 `files` 里；生产清单
 * 按生产 loader 回读，路径穿越与绝对路径被拒。
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { browserBundle, readBuiltAcpWebAssets } from "../../src/acp-web/bundle"
import { acpWebHtml } from "../../src/acp-web/html"

describe("acp-web 浏览器资产", () => {
  test("源码模式：构建出 app.js/app.css/syntax-worker.js，脚本含 /acp/boot 与 /acp/ws", async () => {
    const assets = await browserBundle()
    expect(assets.html).toBe(acpWebHtml)
    expect(Object.keys(assets.files).sort()).toEqual(["app.css", "app.js", "syntax-worker.js"])
    expect(assets.files["app.js"]!.contentType).toBe("text/javascript")
    expect(assets.files["app.css"]!.contentType).toBe("text/css")
    expect(assets.files["app.js"]!.body).toContain("/acp/boot")
    expect(assets.files["app.js"]!.body).toContain("/acp/ws")
  }, 30_000)

  test("HTML 引用的资源名都在 files 里（syntax-worker 经 app.tsx 配置）", () => {
    const names = [...acpWebHtml.matchAll(/\/assets\/([a-z0-9._-]+)/g)].map(m => m[1])
    for (const name of names) expect(["app.css", "app.js", "syntax-worker.js"]).toContain(name)
  })

  test("生产清单：合法 manifest 按生产 loader 回读成同一形状", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-web-assets-"))
    try {
      await writeFile(join(dir, "acp-web.js"), "console.log(1)")
      await writeFile(join(dir, "acp-web.css"), "body{}")
      await writeFile(join(dir, "web-syntax-worker.js"), "self.onmessage=()=>{}")
      await writeFile(join(dir, "acp-web-assets.json"), JSON.stringify({
        version: 1, script: "acp-web.js", style: "acp-web.css", syntaxWorkerScript: "web-syntax-worker.js",
      }))
      const assets = await readBuiltAcpWebAssets(dir)
      expect(assets!.files["app.js"]!.body).toBe("console.log(1)")
      expect(assets!.files["app.css"]!.body).toBe("body{}")
      expect(assets!.files["syntax-worker.js"]!.body).toContain("onmessage")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("清单缺失返回 null；路径穿越与绝对路径被拒（Web 资产路径无效）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-web-assets-"))
    try {
      expect(await readBuiltAcpWebAssets(dir)).toBeNull()
      await writeFile(join(dir, "acp-web-assets.json"), JSON.stringify({
        version: 1, script: "../evil.js", style: "s.css", syntaxWorkerScript: "w.js",
      }))
      await expect(readBuiltAcpWebAssets(dir)).rejects.toThrow("Web 资产路径无效")
      await writeFile(join(dir, "acp-web-assets.json"), JSON.stringify({
        version: 1, script: "/abs/evil.js", style: "s.css", syntaxWorkerScript: "w.js",
      }))
      await expect(readBuiltAcpWebAssets(dir)).rejects.toThrow("Web 资产路径无效")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
