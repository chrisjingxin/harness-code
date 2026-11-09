/** 独立预览编排：先构建公开包，再用同一桌面安全配置启动专用产物。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const desktop = join(root, "apps/desktop")
const output = join(root, "tmp/hc205-ui-preview")
const marker = join(output, ".hc205-preview-output")
const operation = process.argv[2]
if (!["dev", "build", "preview"].includes(operation)) throw new Error("预览命令只支持 dev、build 或 preview")
if (existsSync(output) && (!existsSync(marker) || readFileSync(marker, "utf8") !== "hc205-ui-preview\n")) {
  throw new Error("预览输出目录已存在且不属于本预览，请保留现场并选择其他目录")
}
mkdirSync(output, { recursive: true })
writeFileSync(marker, "hc205-ui-preview\n")
// Electron 必须将本目录的 main 产物按 ESM 加载，而非沿用根 package.json 的默认类型。
writeFileSync(join(output, "package.json"), JSON.stringify({ private: true, type: "module", main: "main/index.js" }) + "\n")

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error("请通过 npm 脚本运行预览，以确定当前 npm 入口")
const prepare = spawnSync(process.execPath, [npmCli, "run", "build", "--workspace", "@workbench/contracts", "--workspace", "@workbench/ui"], { cwd: root, stdio: "inherit" })
if (prepare.error) throw prepare.error
if (prepare.status !== 0) process.exit(prepare.status ?? 1)

const cli = join(root, "node_modules/electron-vite/bin/electron-vite.js")
const config = join(desktop, "electron.vite.preview.config.ts")
const args = operation === "dev" ? [] : [operation]
args.push("--config", config)
if (operation !== "build") args.push("--entry", output)
const env = { ...process.env }
// 避免继承生产服务地址、任意入口和禁用 sandbox 的调试设置。
for (const key of ["WORKBENCH_SERVICE_ORIGIN", "WORKBENCH_UI_PREVIEW_DATA", "ELECTRON_ENTRY", "ELECTRON_RENDERER_URL", "ELECTRON_CLI_ARGS", "ELECTRON_EXEC_PATH", "ELECTRON_RUN_AS_NODE", "NO_SANDBOX"]) delete env[key]
const previewData = operation === "build" ? null : mkdtempSync(join(tmpdir(), "hc205-ui-preview-"))
if (previewData) env.WORKBENCH_UI_PREVIEW_DATA = previewData
const child = spawn(process.execPath, [cli, ...args], { cwd: desktop, env, stdio: "inherit" })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))
child.on("error", error => { console.error(error); process.exitCode = 1 })
child.on("close", (code, signal) => {
  // 等 Electron 和其启动器退出后再清理，防止 Chromium 退出时重新写入会话文件。
  if (previewData) rmSync(previewData, { recursive: true, force: true })
  process.exitCode = code ?? (signal ? 1 : 0)
})
