#!/usr/bin/env node
/** 清理工作区的依赖与构建产物（保留 tmp/ 临时文件与测试记录）。 */

import { rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const targets = [
  resolve(root, "node_modules"),
  resolve(root, "packages/agent/.venv"),
  resolve(root, "packages/cli/dist"),
  resolve(root, "packages/cli/.publish"),
  resolve(root, ".pytest_cache"),
  resolve(root, "packages/agent/.pytest_cache"),
]

for (const target of targets) {
  rmSync(target, { recursive: true, force: true })
}

console.log("已清理所有依赖与构建产物（node_modules、.venv、dist、pytest 缓存，已保留 tmp/）")
