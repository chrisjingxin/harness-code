/** Web assets bundle 加载测试：验证仅从构建清单读取生产/开发静态资产。 */

import { describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { browserBundle, readBuiltWebAssets, resolveWebBundleLocations } from "../../src/web/bundle"

describe("web bundle", () => {
  it("生产 manifest 只从固定 dist 内资源加载 app、worker 脚本与样式", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "za38-web-assets-"))
    try {
      await Promise.all([
        writeFile(resolve(directory, "web.js"), "console.log('app')"),
        writeFile(resolve(directory, "web.css"), "body{}"),
        writeFile(resolve(directory, "web-syntax-worker.js"), "console.log('worker')"),
      ])
      await writeFile(
        resolve(directory, "web-assets.json"),
        JSON.stringify({
          version: 1,
          script: "web.js",
          style: "web.css",
          syntaxWorkerScript: "web-syntax-worker.js",
        }),
      )

      const assets = await readBuiltWebAssets(directory)
      expect(assets).not.toBeNull()
      expect(assets?.script).toBe("console.log('app')")
      expect(assets?.style).toBe("body{}")
      expect(assets?.syntaxWorkerScript).toBe("console.log('worker')")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("拒绝包含 .. 或绝对路径的资产引用", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "za38-web-assets-"))
    try {
      await writeFile(
        resolve(directory, "web-assets.json"),
        JSON.stringify({
          version: 1,
          script: "../web.js",
          style: "web.css",
          syntaxWorkerScript: "web-syntax-worker.js",
        }),
      )
      await expect(readBuiltWebAssets(directory)).rejects.toThrow("Web 资产路径无效")

      await writeFile(
        resolve(directory, "web-assets.json"),
        JSON.stringify({
          version: 1,
          script: "/etc/passwd",
          style: "web.css",
          syntaxWorkerScript: "web-syntax-worker.js",
        }),
      )
      await expect(readBuiltWebAssets(directory)).rejects.toThrow("Web 资产路径无效")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("manifest 缺失时返回 null，损坏或版本不匹配时抛出清晰异常", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "za38-web-assets-"))
    try {
      expect(await readBuiltWebAssets(directory)).toBeNull()

      await writeFile(resolve(directory, "web-assets.json"), "invalid json")
      await expect(readBuiltWebAssets(directory)).rejects.toThrow()

      await writeFile(
        resolve(directory, "web-assets.json"),
        JSON.stringify({ version: 2, script: "a.js", style: "a.css", syntaxWorkerScript: "w.js" }),
      )
      await expect(readBuiltWebAssets(directory)).rejects.toThrow("Web 资产清单无效")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("resolveWebBundleLocations 返回预期的构建目录候选", () => {
    const fakeDir = "/app/packages/cli/src/web"
    const locations = resolveWebBundleLocations(fakeDir)
    expect(locations.builtDirectories).toContain(resolve(fakeDir, "../../dist"))
    expect(locations.builtDirectories).toContain(fakeDir)
  })

  it("browserBundle 在有预先构建的 dist 时正常读取，在缺失时抛出提示运行构建的受控错误", async () => {
    // 仓库根目录下已通过 npm run build 构建过 packages/cli/dist
    const assets = await browserBundle()
    expect(assets.script.length).toBeGreaterThan(0)
    expect(assets.style.length).toBeGreaterThan(0)
    expect(assets.syntaxWorkerScript.length).toBeGreaterThan(0)

    // 传入不存在的目录，验证抛出受控异常
    await expect(browserBundle("/tmp/non-existent-za38-dir")).rejects.toThrow("Web 静态资产缺失")
  })

  it("browserBundle 产物是纯粹的浏览器代码，不包含任何 node:* 模块外部导入", async () => {
    const assets = await browserBundle()
    expect(assets.script).not.toMatch(/from\s*["']node:[^"']+["']/)
    expect(assets.syntaxWorkerScript).not.toMatch(/from\s*["']node:[^"']+["']/)
  })
})
