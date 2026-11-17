/** 独立工作台装配预览，示例宿主和页面数据只进入本预览产物。 */
import { defineConfig, mergeConfig } from "vite"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import referencePreview from "../hc219-reference/vite.config.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")

export default defineConfig(mergeConfig(referencePreview, {
  root: directory,
  cacheDir: resolve(repository, "tmp/hc219-workbench-vite"),
  build: { outDir: resolve(repository, "tmp/hc219-workbench-preview") },
}))
