/** 个人与团队协同工作台交互原型（方案 B）独立 Vite 配置，仅作 UI/交互参考，不进入正式桌面或服务端构建。 */
import { defineConfig } from "vite"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, "../../../..")

export default defineConfig({
  root: directory,
  base: "./",
  cacheDir: resolve(repository, "tmp/personal-team-workbench-vite"),
  server: {
    host: "127.0.0.1",
    port: 57842,
    strictPort: true,
    fs: { allow: [directory, repository] },
  },
  preview: {
    host: "127.0.0.1",
    port: 57842,
    strictPort: true,
  },
  build: {
    outDir: resolve(repository, "tmp/personal-team-workbench-preview"),
    emptyOutDir: true,
  },
})
