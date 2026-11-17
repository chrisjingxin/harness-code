/** 将服务地址交给现有桌面入口，不在命令或仓库中保存登录信息。 */
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const address = process.argv[2] ?? process.env.WORKBENCH_SERVICE_ORIGIN
if (process.argv.length > 3 || !address || address === "--help") {
  console.error("用法：npm run dev:remote -- <Java 服务地址>")
  process.exit(address === "--help" && process.argv.length === 3 ? 0 : 1)
}

let url
try { url = new URL(address) } catch { console.error("Java 服务地址必须是完整的 HTTP 或 HTTPS 地址。"); process.exit(1) }
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  console.error("Java 服务地址不能包含账号、密码、路径或查询参数。")
  process.exit(1)
}
if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  console.error("远端 HTTP 传输未加密；演示登录不适合处理敏感数据。")
}

const npm = process.env.npm_execpath
if (!npm) { console.error("请通过 npm run dev:remote 启动。"); process.exit(1) }
console.log(`连接 Java 服务：${url.origin}`)
const child = spawn(process.execPath, [npm, "run", "dev"], {
  cwd: root,
  env: { ...process.env, WORKBENCH_SERVICE_ORIGIN: url.origin },
  stdio: "inherit",
})
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal))
child.once("error", error => { console.error(`启动桌面失败：${error.message}`); process.exitCode = 1 })
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
