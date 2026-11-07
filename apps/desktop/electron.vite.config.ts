/** 桌面三进程构建边界；preload 打包成 sandbox 可加载的单个 CommonJS 文件。 */
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  // 将公开schema源编入main，避免外置JSON导入在打包时丢失Node所需的导入属性。
  main: { build: { outDir: "dist/main", externalizeDeps: { exclude: ["@workbench/contracts"] } } },
  preload: { build: { outDir: "dist/preload", rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } } },
  renderer: {
    plugins: [react(), {
      name: "workbench-content-policy",
      transformIndexHtml(html, context) {
        // 仅开发页面允许 React 刷新脚本和本机 HMR；生产页面没有 websocket 连接许可。
        const script = context.server ? "'self' 'unsafe-inline'" : "'self'"
        const connect = context.server ? "'self' ws://127.0.0.1:*" : "'self'"
        return html.replace("__WORKBENCH_CSP__", `default-src 'self'; script-src ${script}; style-src 'self' 'unsafe-inline'; connect-src ${connect}; img-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'`)
      },
    }],
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1" },
    build: { outDir: "dist/renderer" },
  },
})
