import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  OPENTUI_NATIVE_PACKAGE_SPECS,
  VENDORED_PACKAGE_SPECS,
  validateExecutionPlatform,
  validateInstalledOpenTuiNativePackage,
  validateInstalledVendoredWorkspace,
  validateVendoredInstallInputs,
  validateVendoredSourceSnapshot,
  validateVendoredWorkspace,
} from "./vendor_policy.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-vendor-policy-"))
  mkdirSync(join(root, "packages/cli"), { recursive: true })
  mkdirSync(join(root, "third_party/npm/@opentui"), { recursive: true })

  writeJson(join(root, "package.json"), {
    name: "fixture",
    workspaces: ["packages/*", "third_party/npm/*", "third_party/npm/@opentui/*"],
  })

  for (const spec of VENDORED_PACKAGE_SPECS) {
    const packageRoot = join(root, spec.path)
    mkdirSync(packageRoot, { recursive: true })
    writeJson(join(packageRoot, "package.json"), {
      name: spec.name,
      version: spec.version,
    })
    if (spec.name === "@opentui/core-win32-x64") {
      writeFileSync(join(packageRoot, "opentui.dll"), "fixture dll\n", "utf-8")
    }
  }

  const packages = {
    "": { name: "fixture" },
  }
  for (const spec of VENDORED_PACKAGE_SPECS) {
    packages[`node_modules/${spec.name}`] = {
      resolved: spec.path,
      link: true,
    }
  }
  for (const nativeSpec of OPENTUI_NATIVE_PACKAGE_SPECS) {
    if (nativeSpec.name === "@opentui/core-win32-x64") continue
    packages[`node_modules/${nativeSpec.name}`] = {
      version: nativeSpec.version,
      resolved: `https://registry.example.internal/${nativeSpec.name}`,
      integrity: "sha512-fixture",
    }
  }
  writeJson(join(root, "package-lock.json"), { name: "fixture", lockfileVersion: 3, packages })

  return root
}

function withFixture(fn) {
  const root = createFixture()
  fn(root)
}

test("audits the repository snapshot with the full cross-platform lock matrix", () => {
  assert.deepEqual(validateVendoredWorkspace(ROOT), [])
})

test("accepts complete vendored workspace fixture", () => {
  withFixture((root) => {
    assert.deepEqual(validateVendoredWorkspace(root), [])
  })
})

test("checks only current platform native lock during installation", () => {
  withFixture((root) => {
    assert.deepEqual(validateVendoredInstallInputs(root, "win32", "x64"), [])
  })
})

test("rejects a Windows target package without opentui.dll", () => {
  withFixture((root) => {
    const dll = join(root, "third_party/npm/@opentui/core-win32-x64/opentui.dll")
    writeFileSync(dll, "", "utf-8")
    const issues = validateVendoredSourceSnapshot(root)
    assert.ok(issues.some((i) => i.includes("missing non-empty opentui.dll")))
  })
})

test("accepts every supported OpenTUI execution platform", () => {
  assert.deepEqual(validateExecutionPlatform("darwin", "x64"), [])
  assert.deepEqual(validateExecutionPlatform("darwin", "arm64"), [])
  assert.deepEqual(validateExecutionPlatform("win32", "x64"), [])
  assert.deepEqual(validateExecutionPlatform("win32", "arm64"), [])
  assert.deepEqual(validateExecutionPlatform("linux", "x64", "glibc"), [])
  assert.deepEqual(validateExecutionPlatform("linux", "arm64", "musl"), [])
})

test("rejects an unsupported OpenTUI platform or architecture", () => {
  assert.ok(validateExecutionPlatform("freebsd", "x64").length > 0)
  assert.ok(validateExecutionPlatform("linux", "mips").length > 0)
  assert.ok(validateExecutionPlatform("linux", "x64", "unknown_libc").length > 0)
})

test("accepts installed workspace links when symlinked to third_party", () => {
  withFixture((root) => {
    mkdirSync(join(root, "node_modules/@opentui"), { recursive: true })
    for (const spec of VENDORED_PACKAGE_SPECS) {
      const linkPath = join(root, "node_modules", spec.name)
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(join(root, spec.path), linkPath, "junction")
    }
    assert.deepEqual(validateInstalledVendoredWorkspace(root, true), [])
  })
})

test("accepts installed OpenTUI native package with native library", () => {
  withFixture((root) => {
    const pkgDir = join(root, "node_modules/@opentui/core-darwin-arm64")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "opentui.dylib"), "binary\n", "utf-8")
    assert.deepEqual(validateInstalledOpenTuiNativePackage(root, "darwin", "arm64", undefined, true), [])
  })
})
