/**
 * 附件块格式漂移：同一段字节，Python `format_inline_block` 与
 * `resolveMentions` 的 contextBlock 必须逐字相同。
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { resolveMentions } from "../../src/workspace/mention-resolver"

const PYTHON = join(import.meta.dir, "../../../agent/.venv/bin/python")
const AGENT_ROOT = join(import.meta.dir, "../../../agent")

describe("附件块格式", () => {
  test("sample.py 的围栏与行数和 Python 一致", async () => {
    const content = "x = 1\n```keep```\n"
    const root = mkdtempSync(join(tmpdir(), "hc200-inline-"))
    writeFileSync(join(root, "sample.py"), content)
    const py = spawnSync(PYTHON, ["-c", `
import json, sys
from harness_agent.host.acp.inline import format_inline_block
print(format_inline_block("sample.py", json.loads(sys.stdin.read())), end="")
`], {
      cwd: AGENT_ROOT,
      input: JSON.stringify(content),
      encoding: "utf8",
    })
    expect(py.status, py.stderr).toBe(0)
    const resolved = await resolveMentions(root, "@sample.py 解释一下")
    expect(resolved.contextBlock).toBe(py.stdout)
    expect(resolved.contextBlock.startsWith("[Attached Context: sample.py (")).toBe(true)
    expect(resolved.contextBlock).toContain("````python")
  })
})
