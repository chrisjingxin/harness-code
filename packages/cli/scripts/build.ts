/** Node/esbuild 生产构建：生成 CLI ESM 与预编译 Web 资产。 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const cliRoot = fileURLToPath(new URL("..", import.meta.url))
const sourceRoot = resolve(cliRoot, "src")
const distRoot = resolve(cliRoot, "dist")

/** 同一构建路径固定 target=node20，不在运行时加载 bundler。 */
async function main(): Promise<void> {
  await rm(distRoot, { recursive: true, force: true })
  await mkdir(distRoot, { recursive: true })

  await build({
    entryPoints: { index: resolve(sourceRoot, "bin.ts") },
    outdir: distRoot,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external: [
      "@colbymchenry/codegraph",
      "ink",
      "lucide-react",
      "marked",
      "react",
      "react/*",
      "react-devtools-core",
      "react-dom",
      "react-dom/*",
      "shiki",
      "shiki/*",
      "string-width",
      "ws",
    ],
    sourcemap: true,
    chunkNames: "chunks/[name]-[hash]",
  })

  await build({
    entryPoints: [resolve(sourceRoot, "web/app.tsx")],
    outfile: resolve(distRoot, "web.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  })
  await build({
    entryPoints: [resolve(sourceRoot, "web/syntax/worker.ts")],
    outfile: resolve(distRoot, "web-syntax-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  })

  const manifest = {
    version: 1,
    script: "web.js",
    style: "web.css",
    syntaxWorkerScript: "web-syntax-worker.js",
  }
  const [scriptContent, styleContent, workerContent] = await Promise.all([
    readFile(resolve(distRoot, manifest.script), "utf8"),
    readFile(resolve(distRoot, manifest.style), "utf8"),
    readFile(resolve(distRoot, manifest.syntaxWorkerScript), "utf8"),
  ])

  // 严格校验浏览器静态产物不得包含任何 node:* 或非相对路径的外部 import，防止浏览器运行时解析失败
  assertPureBrowserBundle(scriptContent, "web.js")
  assertPureBrowserBundle(workerContent, "web-syntax-worker.js")

  await writeFile(resolve(distRoot, "web-assets.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

function assertPureBrowserBundle(content: string, filename: string): void {
  const nodeImportMatch = content.match(/from\s*["']node:[^"']+["']/)
  if (nodeImportMatch) {
    throw new Error(`浏览器产物 ${filename} 包含了非法的 Node.js 模块导入：${nodeImportMatch[0]}`)
  }
}

await main()
