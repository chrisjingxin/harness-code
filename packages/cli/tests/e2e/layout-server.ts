/** 浏览器布局测试服务：只提供真实组件的合成数据预览，监听本机随机端口。 */
import { fileURLToPath } from "node:url"
const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("./fixtures/layout-app.tsx", import.meta.url))], target: "browser" })
if (!result.success) throw new Error(result.logs.join("\n"))
const js = await result.outputs.find(file => file.path.endsWith(".js"))!.text()
const css = await result.outputs.find(file => file.path.endsWith(".css"))!.text()
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  if (path === "/app.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } })
  if (path === "/app.css") return new Response(css, { headers: { "Content-Type": "text/css" } })
  return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>主仓库布局走查 · 合成数据</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script></html>', { headers: { "Content-Type": "text/html" } })
} })
console.log(`LAYOUT_URL=http://127.0.0.1:${server.port}`)
