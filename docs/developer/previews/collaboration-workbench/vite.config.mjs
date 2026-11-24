/** 协作工作台双层交互原型独立 Vite 配置，仅作 UI/交互对照，不进入正式构建。 */
import { defineConfig } from "vite"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")

export default defineConfig({
  root: directory,
  base: "./",
  cacheDir: resolve(repository, "tmp/collaboration-workbench-vite"),
  server: {
    host: "127.0.0.1",
    port: 57843,
    strictPort: true,
    fs: { allow: [directory, repository] },
  },
  preview: {
    host: "127.0.0.1",
    port: 57843,
    strictPort: true,
  },
  build: {
    outDir: resolve(repository, "tmp/collaboration-workbench-preview"),
    emptyOutDir: true,
  },
})
