/** 桌面三进程构建边界；preload 打包成 sandbox 可加载的单个 CommonJS 文件。 */
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

/** 预览只在独立构建时选择夹具入口；正式构建不包含该入口或运行时开关。 */
export function desktopConfig(preview: boolean) {
  const previewRoot = resolve("src/renderer/hc205-preview")
  const previewOutput = resolve("../../tmp/hc205-ui-preview")
  return defineConfig({
    // 将公开 schema 源编入 main，避免外置 JSON 丢失 Node 所需的导入属性。
    main: {
      define: { __WORKBENCH_UI_PREVIEW__: JSON.stringify(preview) },
      build: { outDir: preview ? resolve(previewOutput, "main") : "dist/main", externalizeDeps: { exclude: ["@workbench/contracts"] } },
    },
    preload: { build: { outDir: preview ? resolve(previewOutput, "preload") : "dist/preload", rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } } },
    renderer: {
      ...(preview ? { root: previewRoot } : {}),
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
      build: {
        outDir: preview ? resolve(previewOutput, "renderer") : "dist/renderer",
        ...(preview ? { rollupOptions: { input: resolve(previewRoot, "index.html") } } : {}),
      },
    },
  })
}

export default desktopConfig(false)
