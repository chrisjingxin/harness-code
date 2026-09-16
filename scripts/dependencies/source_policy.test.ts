import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { expect, test } from "bun:test"
import {
  DependencyPreflightError,
  expectedBunVersion,
  expectedNpmVersion,
  resolveInternalSources,
  validateNpmLockSource,
  validateToolchainVersions,
  validateUvLockSource,
} from "./source_policy"

const INTERNAL_ENV = {
  HARNESS_NPM_REGISTRY: "https://npm.intranet.example/",
  HARNESS_PYPI_INDEX: "https://pypi.intranet.example/simple/",
}
const ROOT = resolve(import.meta.dir, "../..")

test("requires explicit non-public npm and Python sources", () => {
  expect(() => resolveInternalSources({})).toThrow(DependencyPreflightError)
  expect(() => resolveInternalSources({
    HARNESS_NPM_REGISTRY: "https://registry.npmjs.org/",
    HARNESS_PYPI_INDEX: "https://pypi.intranet.example/simple/",
  })).toThrow("公网包源")
  expect(() => resolveInternalSources({
    ...INTERNAL_ENV,
    PIP_INDEX_URL: "https://pypi.org/simple/",
  })).toThrow("PIP_INDEX_URL 配置")
})

test("accepts internal source aliases and rejects public lock provenance", () => {
  const sources = resolveInternalSources(INTERNAL_ENV)
  expect(sources.npmRegistry.hostname).toBe("npm.intranet.example")
  expect(sources.pythonIndex.hostname).toBe("pypi.intranet.example")

  const issues = validateUvLockSource(resolve(ROOT, "packages/agent/uv.lock"), sources)
  expect(issues.some((issue) => issue.includes("公网包源") || issue.includes("不一致"))).toBe(true)
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

  expect(validateUvLockSource(`${temp}/uv.lock`, sources)).toEqual([])
  expect(validateNpmLockSource(`${temp}/package-lock.json`, sources)).toEqual([])
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
  expect(validateNpmLockSource(temp, sources)).toContain(`npm 锁文件 ${temp} 仍指向公网包源 registry.npmjs.org`)
})

test("rejects a missing npm lockfile", () => {
  const sources = resolveInternalSources(INTERNAL_ENV)
  const temp = mkdtempSync(resolve(tmpdir(), "harness-source-policy-missing-"))
  const issues = validateNpmLockSource(`${temp}/package-lock.json`, sources)
  expect(issues.some((issue) => issue.includes("找不到 npm 锁文件"))).toBe(true)
})

test("reads the Bun runtime version from engines.bun", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "harness-source-policy-bun-"))
  writeFileSync(`${temp}/package.json`, JSON.stringify({ engines: { bun: "1.2.19" } }))
  expect(expectedBunVersion(temp)).toBe("1.2.19")

  writeFileSync(`${temp}/package.json`, JSON.stringify({ packageManager: "bun@1.2.19" }))
  expect(() => expectedBunVersion(temp)).toThrow(DependencyPreflightError)
})

test("reads the npm package manager version from packageManager", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "harness-source-policy-npm-"))
  writeFileSync(`${temp}/package.json`, JSON.stringify({ packageManager: "npm@11.11.0" }))
  expect(expectedNpmVersion(temp)).toBe("11.11.0")

  writeFileSync(`${temp}/package.json`, JSON.stringify({ packageManager: "bun@1.2.19" }))
  expect(() => expectedNpmVersion(temp)).toThrow(DependencyPreflightError)
})

test("checks the repository toolchain contract", () => {
  expect(expectedBunVersion(ROOT)).toBe("1.2.19")
  expect(expectedNpmVersion(ROOT)).toBe("11.11.0")
  const ok = validateToolchainVersions({
    bun: "1.2.19",
    uv: "0.11.30",
    python: "3.12.9",
    npm: "11.11.0",
    node: "24.14.1",
    expectedBun: "1.2.19",
  })
  expect(ok).toEqual([])
  const mismatched = validateToolchainVersions({
    bun: "1.3.14",
    uv: "0.10.9",
    python: "3.10.9",
    npm: "9.9.9",
    node: "18.20.4",
    expectedBun: "1.2.19",
  })
  expect(mismatched).toHaveLength(5)
})
