/** 知识预览使用独立入口和产物，复用已有预览的 React 解析配置。 */
import { defineConfig, mergeConfig } from "vite"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import referencePreview from "../hc219-reference/vite.config.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")

export default defineConfig(mergeConfig(referencePreview, {
  root: directory,
  cacheDir: resolve(repository, "tmp/hc219-knowledge-vite"),
  build: { outDir: resolve(repository, "tmp/hc219-knowledge-preview") },
}))
