import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const cliManifest = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8"))

test("pins the remaining Bun runtime to 1.3.13", () => {
  assert.equal(manifest.engines?.bun, "1.3.13")
})

test("exposes unified deps:sync command", () => {
  assert.equal(manifest.scripts?.["deps:sync"], "node scripts/dependencies/sync.mjs")
})

test("declares OpenTUI's web-tree-sitter peer because npm does not install peers", () => {
  const core = JSON.parse(readFileSync(resolve(root, "third_party/npm/@opentui/core/package.json"), "utf8"))
  assert.equal(cliManifest.dependencies?.["web-tree-sitter"], core.peerDependencies?.["web-tree-sitter"])
})
