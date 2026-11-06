/** S3-A 边界规则：bridge/client 分层与日志纪律。 */

import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "../../src")

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path)
  }
  return out
}

const bridgeFiles = sources(join(SRC, "acp-web", "bridge"))
const acpWebFiles = sources(join(SRC, "acp-web"))

describe("acp-web 边界", () => {
  test("bridge/** 不 import ../client/**，不用 console.log", () => {
    for (const file of bridgeFiles) {
      const text = readFileSync(file, "utf8")
      expect(text).not.toContain("../client/")
      expect(text).not.toContain("console.log")
    }
  })

  test("client/**（若存在）不 import ../bridge/**、无 node: 导入、无 Bun.", () => {
    let clientDir: string
    try {
      clientDir = join(SRC, "acp-web", "client")
      statSync(clientDir)
    } catch {
      return // S3-A 还没有 client/
    }
    for (const file of sources(clientDir)) {
      const text = readFileSync(file, "utf8")
      expect(text).not.toContain("../bridge/")
      expect(text).not.toMatch(/from "node:/)
      expect(text).not.toContain("Bun.")
    }
  })

  test("web-command.ts 不 import acp-web/client/**", () => {
    const text = readFileSync(join(SRC, "web-command.ts"), "utf8")
    expect(text).not.toContain("acp-web/client")
  })

  test("acp-web/** 不含 Harness Session 字样", () => {
    for (const file of acpWebFiles) {
      expect(readFileSync(file, "utf8")).not.toContain("Harness Session")
    }
  })
})
