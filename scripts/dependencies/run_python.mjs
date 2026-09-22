#!/usr/bin/env node
/** 使用项目虚拟环境运行 Python 命令，兼容 Unix 与 Windows。 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const agent = resolve(root, "packages/agent")
const environment = process.env.UV_PROJECT_ENVIRONMENT
  ? resolve(agent, process.env.UV_PROJECT_ENVIRONMENT)
  : resolve(agent, ".venv")
const candidates = process.platform === "win32"
  ? [resolve(environment, "Scripts/python.exe")]
  : [resolve(environment, "bin/python")]
const python = process.env.HARNESS_AGENT_PYTHON ?? candidates.find(existsSync)
if (!python) {
  console.error("未找到 packages/agent/.venv 中的 Python，请先运行 npm run deps:sync")
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("用法：node scripts/dependencies/run_python.mjs <Python 参数>")
  process.exit(1)
}
const result = spawnSync(python, args, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
})
if (result.error) console.error(`无法启动 Python：${result.error.message}`)
process.exit(result.status ?? 1)
