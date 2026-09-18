/** 加载 Web JS/CSS/Worker 构建产物；运行时只读取预构建的静态资产清单。 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type WebAssets = {
  script: string
  style: string
  syntaxWorkerScript: string
}

/**
 * Web 生产资产清单。所有路径都是 dist 目录内的相对路径，server 只会把它们投影为
 * 固定白名单 URL，不会使用请求路径访问文件系统。
 */
export type WebAssetsManifest = {
  readonly version: 1
  readonly script: string
  readonly style: string
  readonly syntaxWorkerScript: string
}

/** 获取当前模块所在物理目录。 */
function getCurrentModuleDir(): string {
  return fileURLToPath(new URL(".", import.meta.url))
}

/** 根据当前 bundle 模块所在目录解析构建资产的位置。 */
export function resolveWebBundleLocations(moduleDir?: string): {
  builtDirectories: readonly string[]
} {
  const baseDir = moduleDir ?? getCurrentModuleDir()
  return {
    builtDirectories: [
      resolve(baseDir, "../../dist"),
      resolve(baseDir, "../dist"),
      resolve(baseDir),
    ],
  }
}

/** 加载当前运行形态所需的完整 Web 资产；运行时仅从预构建的 dist 读取。 */
export async function browserBundle(customModuleDir?: string): Promise<WebAssets> {
  const locations = resolveWebBundleLocations(customModuleDir)
  for (const directory of locations.builtDirectories) {
    const assets = await readBuiltWebAssets(directory)
    if (assets) return assets
  }

  throw new Error("Web 静态资产缺失。请先运行 `npm run build` 生成 Web assets。")
}

/** 读取生产构建清单；清单缺失表示该目录不是可运行的 Web dist。 */
export async function readBuiltWebAssets(directory: string): Promise<WebAssets | null> {
  const manifestPath = resolve(directory, "web-assets.json")
  if (!existsSync(manifestPath)) return null

  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  if (!isWebAssetsManifest(raw)) {
    throw new Error(`Web 资产清单无效：${manifestPath}`)
  }

  const [script, style, syntaxWorkerScript] = await Promise.all([
    readFile(resolveAssetPath(directory, raw.script), "utf8"),
    readFile(resolveAssetPath(directory, raw.style), "utf8"),
    readFile(resolveAssetPath(directory, raw.syntaxWorkerScript), "utf8"),
  ])
  return { script, style, syntaxWorkerScript }
}

/** 只接受 dist 内普通相对文件名，避免被损坏的清单带出构建目录。 */
function resolveAssetPath(directory: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Web 资产路径无效：${relativePath}`)
  }
  return resolve(directory, relativePath)
}

function isWebAssetsManifest(value: unknown): value is WebAssetsManifest {
  if (!value || typeof value !== "object") return false
  const manifest = value as Partial<WebAssetsManifest>
  return manifest.version === 1
    && typeof manifest.script === "string"
    && typeof manifest.style === "string"
    && typeof manifest.syntaxWorkerScript === "string"
}
