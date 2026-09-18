/**
 * 零 Bun 与零 OpenTUI 门禁扫描：确保生产源码、工程脚本与依赖中完全不含遗留运行时。
 */

import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/** 扫描目录中所有活跃 TS/TSX 文件中的非法 Bun/OpenTUI 标记。 */
export async function checkZeroBun(projectRoot: string): Promise<void> {
  // 1. 检查是否存在 bun.lock / bun.lockb
  const bunLocks = ["bun.lock", "bun.lockb"]
  for (const lock of bunLocks) {
    if (existsSync(join(projectRoot, lock))) {
      throw new Error(`发现遗留的 Bun 锁文件：${lock}，请使用 package-lock.json`)
    }
  }

  // 2. 检查 packages/cli/package.json 不含 @opentui 生产依赖
  const cliPkgPath = join(projectRoot, "packages/cli/package.json")
  if (existsSync(cliPkgPath)) {
    const pkg = JSON.parse(await readFile(cliPkgPath, "utf8")) as { dependencies?: Record<string, string> }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith("@opentui/")) {
        throw new Error(`packages/cli/package.json dependencies 中包含非法的 OpenTUI 依赖：${dep}`)
      }
    }
  }

  // 3. 扫描活跃代码路径
  const scanDirs = [
    join(projectRoot, "packages/cli/src"),
    join(projectRoot, "packages/cli/scripts"),
    join(projectRoot, "packages/protocol/src"),
    join(projectRoot, "scripts"),
  ]

  const violations: string[] = []

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue
    const files = await collectSourceFiles(dir)
    for (const file of files) {
      if (file.endsWith("bun-scan.ts")) continue
      const content = await readFile(file, "utf8")
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (/\bfrom\s+["']bun[:"']/.test(line) || /\bimport\s*\(?["']bun[:"']/.test(line)) {
          violations.push(`${file}:${i + 1} 发现 Bun 模块引入：${line.trim()}`)
        }
        if (/\bBun\.[a-zA-Z]/.test(line)) {
          violations.push(`${file}:${i + 1} 发现 Bun 全局对象使用：${line.trim()}`)
        }
        if (/@opentui\//.test(line)) {
          violations.push(`${file}:${i + 1} 发现 OpenTUI 依赖引入：${line.trim()}`)
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`零 Bun / OpenTUI 门禁扫描未通过，发现 ${violations.length} 处违规：\n` + violations.join("\n"))
  }
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".publish") continue
      files.push(...(await collectSourceFiles(full)))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
        files.push(full)
      }
    }
  }
  return files
}
