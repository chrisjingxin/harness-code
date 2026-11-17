/** 复用 HC-219 的独立预览设置，本入口使用自己的根目录与产物。 */
import { defineConfig, mergeConfig } from "vite"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import referencePreview from "../hc219-reference/vite.config.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")

export default defineConfig(mergeConfig(referencePreview, {
  root: directory,
  cacheDir: resolve(repository, "tmp/hc219-tasks-vite"),
  build: { outDir: resolve(repository, "tmp/hc219-tasks-preview") },
}))
