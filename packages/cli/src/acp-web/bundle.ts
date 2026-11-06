/**
 * ACP Web 浏览器包的资产提供者：把 `client/app.tsx`（源码模式即时构建）或
 * `dist/acp-web.*`（生产模式按清单回读）变成桥能服务的 `AcpWebAssets`。
 *
 * 与 `web/bundle.ts` 的区别：
 * - 资产形状不同：桥按 `{html, files}` 服务 `/assets/<key>`，清单映射到
 *   `app.js` / `app.css` / `syntax-worker.js` 三个固定 key；
 * - app 构建**不设 `external`**：旧 Web 构建把 `fs/path/module` extern 掉会
 *   把"浏览器代码误 import Node 模块"的空桩问题藏起来（探索 E1 §1.4），
 *   这里保留 extern 列表为空，让违规在构建期就失败；
 * - 高亮 Worker 复用 `web/syntax/worker.ts`，沿用其现有 extern 设置。
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { resolveAssetPath } from "../web/bundle"
import type { AcpWebAssets } from "./bridge/assets"
import { acpWebHtml } from "./html"

export type AcpWebAssetsManifest = {
  readonly version: 1
  readonly script: string
  readonly style: string
  readonly syntaxWorkerScript: string
}

let sourceBundlePromise: Promise<AcpWebAssets> | undefined

/** 根据当前 bundle 模块所在目录解析 source 与 dist 两种运行形态的资源位置。 */
export function resolveAcpWebBundleLocations(moduleDir: string): {
  builtDirectories: readonly string[]
  sourceEntrypoints: readonly string[]
} {
  return {
    builtDirectories: [
      resolve(moduleDir, "../../dist"),
      resolve(moduleDir),
    ],
    sourceEntrypoints: [
      resolve(moduleDir, "client/app.tsx"),
      resolve(moduleDir, "../src/acp-web/client/app.tsx"),
    ],
  }
}

/** 加载当前运行形态所需的 ACP Web 资产；源码与 dist 返回同一形状。 */
export async function browserBundle(): Promise<AcpWebAssets> {
  const locations = resolveAcpWebBundleLocations(import.meta.dir)
  const localSourceEntrypoint = locations.sourceEntrypoints[0]!
  if (existsSync(localSourceEntrypoint)) return buildSourceBundle(localSourceEntrypoint)
  for (const directory of locations.builtDirectories) {
    const assets = await readBuiltAcpWebAssets(directory)
    if (assets) return assets
  }

  const sourceEntrypoint = locations.sourceEntrypoints.find(entrypoint => existsSync(entrypoint))
  if (!sourceEntrypoint) throw new Error("ACP Web app entrypoint is missing")
  return buildSourceBundle(sourceEntrypoint)
}

async function buildSourceBundle(sourceEntrypoint: string): Promise<AcpWebAssets> {
  if (sourceBundlePromise) return sourceBundlePromise
  sourceBundlePromise = buildSourceBundleOnce(sourceEntrypoint)
  try {
    return await sourceBundlePromise
  } catch (error) {
    sourceBundlePromise = undefined
    throw error
  }
}

async function buildSourceBundleOnce(sourceEntrypoint: string): Promise<AcpWebAssets> {
  const workerEntrypoint = resolve(import.meta.dir, "../web/syntax/worker.ts")
  const appResult = await Bun.build({
    entrypoints: [sourceEntrypoint],
    target: "browser",
    minify: true,
  })
  const workerResult = await Bun.build({
    entrypoints: [workerEntrypoint],
    target: "browser",
    minify: true,
    external: ["module", "node:module", "fs", "node:fs", "path", "node:path"],
  })

  const scriptOutput = appResult.outputs.find(output => output.path.endsWith(".js"))
  const styleOutput = appResult.outputs.find(output => output.path.endsWith(".css"))
  const workerOutput = workerResult.outputs.find(output => output.path.endsWith(".js"))

  if (!appResult.success || !workerResult.success || !scriptOutput || !styleOutput || !workerOutput) {
    throw new Error(
      [...appResult.logs, ...workerResult.logs].map(log => log.message).join("\n") || "ACP Web bundle build failed",
    )
  }

  return {
    html: acpWebHtml,
    files: {
      "app.js": { contentType: "text/javascript", body: await scriptOutput.text() },
      "app.css": { contentType: "text/css", body: await styleOutput.text() },
      "syntax-worker.js": { contentType: "text/javascript", body: await workerOutput.text() },
    },
  }
}

/** 读取生产构建清单（`dist/acp-web-assets.json`）；清单缺失表示该目录不可运行。 */
export async function readBuiltAcpWebAssets(directory: string): Promise<AcpWebAssets | null> {
  const manifestPath = resolve(directory, "acp-web-assets.json")
  if (!existsSync(manifestPath)) return null

  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  if (!isAcpWebAssetsManifest(raw)) {
    throw new Error(`Web 资产清单无效：${manifestPath}`)
  }

  const [script, style, syntaxWorkerScript] = await Promise.all([
    readFile(resolveAssetPath(directory, raw.script), "utf8"),
    readFile(resolveAssetPath(directory, raw.style), "utf8"),
    readFile(resolveAssetPath(directory, raw.syntaxWorkerScript), "utf8"),
  ])
  return {
    html: acpWebHtml,
    files: {
      "app.js": { contentType: "text/javascript", body: script },
      "app.css": { contentType: "text/css", body: style },
      "syntax-worker.js": { contentType: "text/javascript", body: syntaxWorkerScript },
    },
  }
}

function isAcpWebAssetsManifest(value: unknown): value is AcpWebAssetsManifest {
  if (!value || typeof value !== "object") return false
  const manifest = value as Partial<AcpWebAssetsManifest>
  return manifest.version === 1
    && typeof manifest.script === "string"
    && typeof manifest.style === "string"
    && typeof manifest.syntaxWorkerScript === "string"
}
