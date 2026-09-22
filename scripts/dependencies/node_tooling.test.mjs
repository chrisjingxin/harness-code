import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const cliManifest = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8"))
const protocolManifest = JSON.parse(readFileSync(resolve(root, "packages/protocol/package.json"), "utf8"))
const bunCommand = /(^|[\s;&|])bun(?:[\s;&|]|$)/

test("pins the remaining Bun runtime to 1.3.13", () => {
  assert.equal(manifest.engines?.bun, "1.3.13")
})

test("exposes one dependency sync command and removes the old mode-specific scripts", () => {
  assert.equal(manifest.scripts?.["deps:sync"], "node scripts/dependencies/sync.mjs")
  assert.equal(manifest.scripts?.["deps:install"], undefined)
  assert.equal(manifest.scripts?.["deps:resolve"], undefined)
})

test("dependency and Python test commands do not start Bun", () => {
  for (const name of ["deps:sync", "deps:check", "deps:test", "test:py"]) {
    const command = manifest.scripts?.[name]
    assert.equal(typeof command, "string", `缺少根脚本 ${name}`)
    assert.doesNotMatch(command, /(^|[\s;&|])bun(?:[\s;&|]|$)/, `${name} 仍会启动 Bun: ${command}`)
  }
})

test("protocol and project tooling commands do not start Bun", () => {
  const rootCommands = [
    "project:tool",
    "test:project",
    "protocol:generate",
    "protocol:check",
    "docs:check",
    "tasks:sync",
    "tasks:check",
    "task:claim",
    "task:complete",
    "version:set",
    "release:check",
    "project:check",
  ]
  const commands = [
    ...rootCommands.map((name) => [`package.json#${name}`, manifest.scripts?.[name]]),
    ...["generate", "check"].map((name) => [`packages/protocol/package.json#${name}`, protocolManifest.scripts?.[name]]),
  ]

  for (const [name, command] of commands) {
    assert.equal(typeof command, "string", `缺少工程脚本 ${name}`)
    assert.doesNotMatch(command, bunCommand, `${name} 仍会启动 Bun: ${command}`)
  }
})

test("declares OpenTUI's web-tree-sitter peer because npm does not install peers", () => {
  const core = JSON.parse(readFileSync(resolve(root, "third_party/npm/@opentui/core/package.json"), "utf8"))
  assert.equal(cliManifest.dependencies?.["web-tree-sitter"], core.peerDependencies?.["web-tree-sitter"])
})

test("keeps direct Bun commands inside the minimal CLI runtime island", () => {
  assert.equal(manifest.scripts?.dev, "npm --workspace @za38/cli run dev --")
  assert.equal(cliManifest.scripts?.["syntax:assets"], "node scripts/vendor-syntax-assets.mjs")
  const syntaxAssetSource = readFileSync(resolve(root, "packages/cli/scripts/vendor-syntax-assets.mjs"), "utf8")
  assert.doesNotMatch(syntaxAssetSource, /\bBun\.|\bbun:|import\.meta\.(?:dir|main)\b/)

  const manifests = [
    ["package.json", manifest],
    ["packages/cli/package.json", cliManifest],
    ["packages/protocol/package.json", protocolManifest],
  ]
  const directBunScripts = manifests.flatMap(([relativePath, packageManifest]) =>
    Object.entries(packageManifest.scripts ?? {})
      .filter(([, command]) => bunCommand.test(command))
      .map(([name]) => `${relativePath}#${name}`),
  ).sort()

  assert.deepEqual(directBunScripts, [
    "packages/cli/package.json#build",
    "packages/cli/package.json#dev",
    "packages/cli/package.json#test",
  ])
})

test("uses npm entrypoints in current user and engineering documentation", () => {
  const directories = [
    "docs/user",
    "docs/developer/project",
    "docs/developer/architecture",
  ]
  const files = ["README.md", "AGENTS.md", ...directories.flatMap((directory) =>
    readdirSync(resolve(root, directory))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `${directory}/${name}`),
  )]
  const staleCommands = files.flatMap((relativePath) => {
    const source = readFileSync(resolve(root, relativePath), "utf8")
    return /\bbun run\b|\bnpx\s+--yes\s+bun@[^\s]+\s+run\b/.test(source) ? [relativePath] : []
  })

  assert.deepEqual(staleCommands, [])
})

test("the TypeScript loader rejects files outside repository tooling", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "harness-typescript-loader-"))
  const entry = resolve(temp, "outside.ts")
  writeFileSync(entry, "console.log('unexpected')\n")
  try {
    const result = spawnSync(process.execPath, [
      "--no-warnings",
      "--experimental-loader",
      resolve(root, "scripts/typescript_loader.mjs"),
      entry,
    ], { encoding: "utf8" })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /只允许转译仓库工程工具/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
