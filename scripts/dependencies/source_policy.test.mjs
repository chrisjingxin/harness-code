import assert from "node:assert/strict"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  resolveInternalSources,
  validateLockSources,
  validateNpmLockSource,
  validateToolchainVersions,
  validateUvLockSource,
} from "./source_policy.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

test("defaults to public registries when no tool source or override is configured", () => {
  const sources = resolveInternalSources({})
  assert.equal(sources.npmRegistry.hostname, "registry.npmjs.org")
  assert.equal(sources.pythonIndex.hostname, "pypi.org")
})

test("uses npm and pip configured internal sources", () => {
  const sources = resolveInternalSources({}, {
    npmRegistry: "https://npm.configured.example/",
    pythonIndex: "https://pypi.configured.example/simple/",
  })
  assert.equal(sources.npmRegistry.hostname, "npm.configured.example")
  assert.equal(sources.pythonIndex.hostname, "pypi.configured.example")
})

test("uses HARNESS environment overrides", () => {
  const sources = resolveInternalSources({
    HARNESS_NPM_REGISTRY: "https://npm.intranet.example/",
    HARNESS_PYPI_INDEX: "https://pypi.intranet.example/simple/",
  })
  assert.equal(sources.npmRegistry.hostname, "npm.intranet.example")
  assert.equal(sources.pythonIndex.hostname, "pypi.intranet.example")
})

test("validates existence of project lockfiles", () => {
  assert.deepEqual(validateNpmLockSource(resolve(ROOT, "package-lock.json")), [])
  assert.deepEqual(validateUvLockSource(resolve(ROOT, "packages/agent/uv.lock")), [])
  assert.deepEqual(validateLockSources(ROOT), [])
  assert.ok(validateNpmLockSource(resolve(ROOT, "nonexistent-lock.json")).length > 0)
})

test("checks the repository toolchain contract", () => {
  assert.deepEqual(validateToolchainVersions({
    npm: "11.11.0",
    node: "20.12.0",
    uv: "0.11.1",
    python: "3.11.8",
  }), [])

  assert.ok(validateToolchainVersions({ npm: "9.0.0" }).length > 0)
  assert.ok(validateToolchainVersions({ node: "18.0.0" }).length > 0)
  assert.ok(validateToolchainVersions({ uv: "0.9.0" }).length > 0)
  assert.ok(validateToolchainVersions({ python: "3.10.0" }).length > 0)
})
