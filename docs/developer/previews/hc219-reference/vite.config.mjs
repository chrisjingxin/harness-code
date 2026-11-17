/** 独立预览构建，固定数据只进入本目录的产物。 */
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")
const desktopRequire = createRequire(resolve(repository, "apps/desktop/package.json"))

export default defineConfig({
  root: directory,
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: { "react-dom": dirname(desktopRequire.resolve("react-dom/package.json")) },
  },
  cacheDir: resolve(repository, "tmp/hc219-reference-vite"),
  build: { outDir: resolve(repository, "tmp/hc219-reference-preview"), emptyOutDir: true },
})
