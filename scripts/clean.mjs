#!/usr/bin/env node
/** 清理工作区的依赖与构建产物（保留 tmp/ 临时文件与测试记录）。 */

import { readFileSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const workspaceOutputs = (manifest.workspaces ?? []).flatMap(workspace => [
  resolve(root, workspace, "dist"),
  ...(workspace === "desktop" ? [resolve(root, workspace, "out")] : []),
])
const targets = [
  resolve(root, "node_modules"),
  ...workspaceOutputs,
  resolve(root, "packages/collaboration-client/src/schema"),
  resolve(root, "agent/.venv"),
  resolve(root, ".pytest_cache"),
  resolve(root, "agent/.pytest_cache"),
  resolve(root, "server/target"),
]

for (const target of targets) {
  rmSync(target, { recursive: true, force: true })
}

console.log("已清理所有依赖与构建产物（node_modules、新工作区 dist/out、agent/.venv、pytest 缓存、server/target，已保留 tmp/）")
