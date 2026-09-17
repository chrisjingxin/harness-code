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
    external: ["node:*", "module", "fs", "path"],
  })
  await build({
    entryPoints: [resolve(sourceRoot, "web/syntax/worker.ts")],
    outfile: resolve(distRoot, "web-syntax-worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    external: ["node:*", "module"],
  })

  const manifest = {
    version: 1,
    script: "web.js",
    style: "web.css",
    syntaxWorkerScript: "web-syntax-worker.js",
  }
  await Promise.all([
    readFile(resolve(distRoot, manifest.script)),
    readFile(resolve(distRoot, manifest.style)),
    readFile(resolve(distRoot, manifest.syntaxWorkerScript)),
  ])
  await writeFile(resolve(distRoot, "web-assets.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

await main()
