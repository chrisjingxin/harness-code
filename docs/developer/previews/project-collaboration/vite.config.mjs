/** 隔离的前端视觉预览，只消费已有 UI 包，不进入正式桌面或服务端构建。 */
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

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
  cacheDir: resolve(repository, "tmp/project-collaboration-vite"),
  server: { host: "127.0.0.1", port: 57841, strictPort: true, fs: { allow: [repository] } },
  build: { outDir: resolve(repository, "tmp/project-collaboration-design"), emptyOutDir: true },
})
