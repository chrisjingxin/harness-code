/** 桌面三进程构建边界；preload 打包成 sandbox 可加载的单个 CommonJS 文件。 */
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

type PreviewTarget = "hc205" | "hc206" | "hc207" | "hc208"

/** 预览身份只由各自的固定构建配置选择；正式构建没有运行时入口开关。 */
export function desktopConfig(preview: PreviewTarget | null = null) {
  const profile = preview ? {
    root: resolve(`src/renderer/${preview}-preview`),
    output: resolve(`../../tmp/${preview}-ui-preview`),
  } : null
  return defineConfig({
    // 将公开 schema 源编入 main，避免外置 JSON 丢失 Node 所需的导入属性。
    main: {
      define: { __WORKBENCH_UI_PREVIEW__: JSON.stringify(preview) },
      build: { outDir: profile ? resolve(profile.output, "main") : "dist/main", externalizeDeps: { exclude: ["@workbench/contracts"] } },
    },
    preload: { build: { outDir: profile ? resolve(profile.output, "preload") : "dist/preload", rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } } },
    renderer: {
      ...(profile ? { root: profile.root } : {}),
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
        outDir: profile ? resolve(profile.output, "renderer") : "dist/renderer",
        ...(profile ? { rollupOptions: { input: resolve(profile.root, "index.html") } } : {}),
      },
    },
  })
}

export default desktopConfig()
