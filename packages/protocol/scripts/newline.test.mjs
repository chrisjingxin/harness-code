import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { withoutCarriageReturn } from "./newline.mjs"

const protocolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("schema digests ignore carriage returns", () => {
  const cases = [
    ["schema/v3.json", "../agent/harness_agent/protocol/protocol_v3.sha256"],
    ["diagnostic-log/schema/v1.json", "../agent/harness_agent/diagnostic_log/diagnostic_log_v1.sha256"],
  ]
  for (const [schemaPath, digestPath] of cases) {
    const lf = readFileSync(resolve(protocolRoot, schemaPath), "utf8")
    const expected = readFileSync(resolve(protocolRoot, digestPath), "utf8").trim()
    const digest = (text) => createHash("sha256").update(withoutCarriageReturn(text)).digest("hex")
    assert.equal(digest(lf.replaceAll("\n", "\r\n")), expected)
    assert.equal(digest(lf), expected)
  }
})
