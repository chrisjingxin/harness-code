import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  DependencyPreflightError,
  expectedNpmVersion,
  resolveInternalSources,
  validateNpmLockSource,
  validateToolchainVersions,
  validateUvLockSource,
} from "./source_policy.mjs"

const INTERNAL_ENV = {
  HARNESS_NPM_REGISTRY: "https://npm.intranet.example/",
  HARNESS_PYPI_INDEX: "https://pypi.intranet.example/simple/",
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("uses public registries outside the enterprise and the committed locks", () => {
  const sources = resolveInternalSources({}, {
    npmRegistry: "https://registry.npmjs.org/",
  })

  assert.equal(sources.npmRegistry.hostname, "registry.npmjs.org")
  assert.equal(sources.pythonIndex.hostname, "pypi.org")
  assert.deepEqual(validateNpmLockSource(resolve(ROOT, "package-lock.json"), sources), [])
  assert.deepEqual(validateUvLockSource(resolve(ROOT, "packages/agent/uv.lock"), sources), [])
})

test("defaults to public registries when no tool source or HARNESS override is configured", () => {
  const sources = resolveInternalSources({})

  assert.equal(sources.npmRegistry.hostname, "registry.npmjs.org")
  assert.equal(sources.pythonIndex.hostname, "pypi.org")
})

test("does not pair an intranet npm registry with the public Python index", () => {
  assert.throws(() => resolveInternalSources({
    HARNESS_NPM_REGISTRY: "https://npm.intranet.example/",
  }), /内网 index/)
  assert.throws(() => resolveInternalSources({
    ...INTERNAL_ENV,
    PIP_EXTRA_INDEX_URL: "https://pypi.org/simple/",
  }), /PIP_EXTRA_INDEX_URL 配置/)
  assert.throws(() => resolveInternalSources({
    HARNESS_NPM_REGISTRY: "https://user:pass@npm.intranet.example/",
    HARNESS_PYPI_INDEX: "https://pypi.intranet.example/simple/",
  }), /凭据/)
})

test("uses npm and pip configured internal sources without HARNESS overrides", () => {
  const sources = resolveInternalSources({}, {
    npmRegistry: "https://npm.configured.example/",
    pythonIndex: "https://pypi.configured.example/simple/",
  })

  assert.equal(sources.npmRegistry.hostname, "npm.configured.example")
  assert.equal(sources.pythonIndex.hostname, "pypi.configured.example")
})

test("prefers valid tool configuration over HARNESS fallback sources", () => {
  const sources = resolveInternalSources({
    HARNESS_NPM_REGISTRY: "https://npm.fallback.example/",
    HARNESS_PYPI_INDEX: "https://pypi.fallback.example/simple/",
  }, {
    npmRegistry: "https://npm.configured.example/",
    pythonIndex: "https://pypi.configured.example/simple/",
  })

  assert.equal(sources.npmRegistry.hostname, "npm.configured.example")
  assert.equal(sources.pythonIndex.hostname, "pypi.configured.example")
})

test("uses HARNESS sources when tool configuration still points to public registries", () => {
  const sources = resolveInternalSources({
    HARNESS_NPM_REGISTRY: "https://npm.fallback.example/",
    HARNESS_PYPI_INDEX: "https://pypi.fallback.example/simple/",
    PIP_INDEX_URL: "https://pypi.org/simple/",
  }, {
    npmRegistry: "https://registry.npmjs.org/",
    pythonIndex: "https://pypi.org/simple/",
  })

  assert.equal(sources.npmRegistry.hostname, "npm.fallback.example")
  assert.equal(sources.pythonIndex.hostname, "pypi.fallback.example")
})

test("accepts internal source aliases and rejects public lock provenance", () => {
  const sources = resolveInternalSources(INTERNAL_ENV)
  assert.equal(sources.npmRegistry.hostname, "npm.intranet.example")
  assert.equal(sources.pythonIndex.hostname, "pypi.intranet.example")

  const issues = validateUvLockSource(resolve(ROOT, "packages/agent/uv.lock"), sources)
  assert.ok(issues.some((issue) => issue.includes("公网包源") || issue.includes("不一致")))
})

test("validates internal uv provenance and permits npm locks without embedded URLs", () => {
  const sources = resolveInternalSources(INTERNAL_ENV)
  const temp = mkdtempSync(resolve(tmpdir(), "harness-source-policy-"))
  writeFileSync(`${temp}/uv.lock`, [
    '[[package]]',
    'name = "deepagents"',
    'version = "0.7.3"',
    'source = { registry = "https://pypi.intranet.example/simple/" }',
    'wheels = [{ url = "https://pypi.intranet.example/packages/deepagents.whl" }]',
    '',
  ].join("\n"))
  writeFileSync(`${temp}/package-lock.json`, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "za38-cli" },
      "node_modules/@opentui/core": { resolved: "third_party/npm/@opentui/core", link: true },
    },
  }))

  assert.deepEqual(validateUvLockSource(`${temp}/uv.lock`, sources), [])
  assert.deepEqual(validateNpmLockSource(`${temp}/package-lock.json`, sources), [])
})

test("rejects a public URL embedded in an npm lock", () => {
  const sources = resolveInternalSources(INTERNAL_ENV)
  const temp = `${mkdtempSync(resolve(tmpdir(), "harness-source-policy-public-"))}/package-lock.json`
  writeFileSync(temp, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/marked": {
        version: "17.0.1",
        resolved: "https://registry.npmjs.org/marked/-/marked-17.0.1.tgz",
      },
    },
  }))
  assert.ok(validateNpmLockSource(temp, sources).includes(`npm 锁文件 ${temp} 仍指向公网包源 registry.npmjs.org`))
})

test("rejects a missing npm lockfile", () => {
  const sources = resolveInternalSources(INTERNAL_ENV)
  const temp = mkdtempSync(resolve(tmpdir(), "harness-source-policy-missing-"))
  const issues = validateNpmLockSource(`${temp}/package-lock.json`, sources)
  assert.ok(issues.some((issue) => issue.includes("找不到 npm 锁文件")))
})

test("reads the npm package manager version from packageManager", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "harness-source-policy-npm-"))
  writeFileSync(`${temp}/package.json`, JSON.stringify({ packageManager: "npm@11.11.0" }))
  assert.equal(expectedNpmVersion(temp), "11.11.0")

  writeFileSync(`${temp}/package.json`, JSON.stringify({ packageManager: "bun@1.3.13" }))
  assert.throws(() => expectedNpmVersion(temp), DependencyPreflightError)
})

test("checks the repository toolchain contract", () => {
  assert.equal(expectedNpmVersion(ROOT), "11.11.0")
  const ok = validateToolchainVersions({
    uv: "0.11.30",
    python: "3.12.9",
    npm: "11.11.0",
    node: "24.14.1",
  })
  assert.deepEqual(ok, [])
  const mismatched = validateToolchainVersions({
    uv: "0.10.9",
    python: "3.10.9",
    npm: "9.9.9",
    node: "18.20.4",
  })
  assert.equal(mismatched.length, 4)
})

test("uses npm for package-script orchestration and keeps Bun only as a direct runtime", () => {
  const manifests = [
    "package.json",
    "packages/cli/package.json",
    "packages/protocol/package.json",
  ]
  const bunRunScripts = manifests.flatMap((relativePath) => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8"))
    return Object.entries(manifest.scripts ?? {})
      .filter(([, command]) => command.includes("bun run"))
      .map(([name, command]) => `${relativePath}#${name}: ${command}`)
  })

  assert.deepEqual(bunRunScripts, [])
})
