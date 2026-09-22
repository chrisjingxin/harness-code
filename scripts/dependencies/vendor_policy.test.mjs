import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import {
  OPENTUI_NATIVE_PACKAGE_SPECS,
  VENDORED_PACKAGE_SPECS,
  VENDORED_PACKAGE_CONSUMERS,
  directorySha256,
  sha256Hex,
  validateExecutionPlatform,
  validateInstalledOpenTuiNativePackage,
  validateInstalledVendoredWorkspace,
  validateVendoredWorkspace,
} from "./vendor_policy.mjs"

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function mutateProvenance(root, callback) {
  const path = join(root, "third_party/npm/provenance.json")
  const provenance = JSON.parse(readFileSync(path, "utf-8"))
  callback(provenance)
  writeJson(path, provenance)
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "harness-vendor-policy-"))
  mkdirSync(join(root, "packages/cli"), { recursive: true })
  mkdirSync(join(root, "third_party/npm/@opentui"), { recursive: true })

  writeJson(join(root, "package.json"), {
    name: "fixture",
    workspaces: ["packages/*", "third_party/npm/*", "third_party/npm/@opentui/*"],
  })
  writeJson(join(root, "packages/cli/package.json"), {
    dependencies: {
      "@opentui/core": "0.4.3",
      "@opentui/react": "0.4.3",
    },
    devDependencies: {
      "react-devtools-core": "7.0.1",
    },
  })
  mkdirSync(join(root, "patches"), { recursive: true })
  const patchSource = "- ws: ^7\n+ ws: 7.5.10\n"
  writeFileSync(join(root, "patches/react-devtools-core@7.0.1.patch"), patchSource, "utf-8")

  for (const spec of VENDORED_PACKAGE_SPECS) {
    const packageRoot = join(root, spec.path)
    mkdirSync(packageRoot, { recursive: true })
    const packageJson = {
      name: spec.name,
      version: spec.version,
      license: "MIT",
    }
    if (spec.name === "@opentui/core") {
      packageJson.dependencies = { "bun-ffi-structs": "0.2.4" }
      packageJson.optionalDependencies = Object.fromEntries(
        OPENTUI_NATIVE_PACKAGE_SPECS.map((nativeSpec) => [nativeSpec.name, nativeSpec.version]),
      )
    }
    if (spec.name === "@opentui/react") {
      packageJson.dependencies = { "@opentui/core": "0.4.3" }
      packageJson.devDependencies = { "@types/react": "19.2.14" }
    }
    if (spec.name === "react-devtools-core") {
      packageJson.dependencies = { ws: "7.5.10" }
    }
    if (spec.name === "@opentui/core-win32-x64") {
      writeFileSync(join(packageRoot, "opentui.dll"), "fixture dll\n", "utf-8")
    }
    writeJson(join(packageRoot, "package.json"), packageJson)
    writeFileSync(join(packageRoot, "LICENSE"), "MIT\n", "utf-8")
    for (const requiredFile of spec.requiredFiles) {
      if (requiredFile === "package.json" || requiredFile === "LICENSE") continue
      const requiredPath = join(packageRoot, requiredFile)
      mkdirSync(dirname(requiredPath), { recursive: true })
      writeFileSync(requiredPath, "fixture release file\n", "utf-8")
    }
  }

  const provenancePackages = Object.fromEntries(
    VENDORED_PACKAGE_SPECS.map((spec) => [spec.name, {
      name: spec.name,
      version: spec.version,
      path: spec.path,
      tarball: spec.tarball,
      integrity: spec.integrity,
      license: "MIT",
      directorySha256: directorySha256(join(root, spec.path)),
    }]),
  )
  writeJson(join(root, "third_party/npm/provenance.json"), {
    schemaVersion: 1,
    target: { os: "win32", cpu: "x64" },
    packages: provenancePackages,
    normalizations: [
      {
        package: "@opentui/core-win32-x64",
        removedFields: ["os", "cpu"],
        reason: "fixture normalization",
      },
    ],
    patches: {
      "react-devtools-core": {
        source: "patches/react-devtools-core@7.0.1.patch",
        sourceSha256: sha256Hex(patchSource),
      },
    },
  })

  writeJson(join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      ...Object.fromEntries(
        VENDORED_PACKAGE_SPECS.map((spec) => [`node_modules/${spec.name}`, { resolved: spec.path, link: true }]),
      ),
      ...Object.fromEntries(
        OPENTUI_NATIVE_PACKAGE_SPECS
          .filter((spec) => spec.name !== "@opentui/core-win32-x64")
          .map((spec) => [`node_modules/${spec.name}`, {
            version: spec.version,
            resolved: `https://npm.intranet.example/${spec.name}/-/${spec.name.split("/").at(-1)}-${spec.version}.tgz`,
            integrity: "sha512-fixture",
            optional: true,
            os: [spec.platform],
            cpu: [spec.arch],
          }]),
      ),
      "node_modules/marked": {
        version: "17.0.1",
        resolved: "https://npm.intranet.example/marked/-/marked-17.0.1.tgz",
      },
    },
  })
  return root
}

function packageSegments(name) {
  return name.startsWith("@") ? name.split("/") : [name]
}

function linkInstalledPackages(root) {
  for (const spec of VENDORED_PACKAGE_SPECS) {
    for (const consumer of VENDORED_PACKAGE_CONSUMERS[spec.name] ?? []) {
      const link = join(root, consumer, "node_modules", ...packageSegments(spec.name))
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(root, spec.path), link, process.platform === "win32" ? "junction" : "dir")
    }
  }
}

function installOpenTuiNativePackage(root, platform, arch, linuxLibc) {
  const normalizedLibc = platform === "linux" ? (linuxLibc === "musl" ? "musl" : "glibc") : undefined
  const spec = OPENTUI_NATIVE_PACKAGE_SPECS.find((candidate) =>
    candidate.platform === platform && candidate.arch === arch && candidate.libc === normalizedLibc)
  assert.ok(spec, `missing test spec for ${platform}/${arch}/${normalizedLibc ?? "default"}`)
  const packageRoot = join(root, "node_modules", ...packageSegments(spec.name))
  mkdirSync(packageRoot, { recursive: true })
  writeJson(join(packageRoot, "package.json"), {
    name: spec.name,
    version: spec.version,
    license: "MIT",
    type: "module",
    main: "index.js",
    module: "index.js",
    types: "index.d.ts",
    os: [spec.platform],
    cpu: [spec.arch],
  })
  writeFileSync(join(packageRoot, "index.js"), "export default 'fixture'\n", "utf-8")
  writeFileSync(join(packageRoot, "index.bun.js"), "export default 'fixture'\n", "utf-8")
  writeFileSync(join(packageRoot, "index.d.ts"), "declare const path: string\nexport default path\n", "utf-8")
  writeFileSync(join(packageRoot, `opentui${spec.extension}`), "fixture native library\n", "utf-8")
  return { packageRoot, spec }
}

function withFixture(callback) {
  const root = createFixture()
  try {
    callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function assertIncludes(actual, expected) {
  assert.ok(actual.includes(expected), `期望包含 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(actual)}`)
}

test("accepts complete vendored Windows x64 workspace provenance", () => {
  withFixture((root) => assert.deepEqual(validateVendoredWorkspace(root), []))
})

test("rejects a vendored package with the wrong version", () => {
  withFixture((root) => {
    const packageJson = join(root, "third_party/npm/bun-ffi-structs/package.json")
    writeJson(packageJson, { name: "bun-ffi-structs", version: "0.2.3", license: "MIT" })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "version mismatch")
  })
})

test("rejects a vendored package with a missing required entrypoint", () => {
  withFixture((root) => {
    rmSync(join(root, "third_party/npm/bun-ffi-structs/dist/index.js"))
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "required file missing")
  })
})

test("rejects a package with a non-MIT license declaration", () => {
  withFixture((root) => {
    writeJson(join(root, "third_party/npm/bun-ffi-structs/package.json"), {
      name: "bun-ffi-structs",
      version: "0.2.4",
      license: "GPL-3.0",
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "license must be MIT")
  })
})

test("rejects tampered vendored files", () => {
  withFixture((root) => {
    writeFileSync(join(root, "third_party/npm/bun-ffi-structs/README.md"), "tampered\n", "utf-8")
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "directory hash mismatch")
  })
})

test("ignores Bun workspace installation output in the release directory hash", () => {
  withFixture((root) => {
    mkdirSync(join(root, "third_party/npm/bun-ffi-structs/node_modules/generated"), { recursive: true })
    writeFileSync(join(root, "third_party/npm/bun-ffi-structs/node_modules/generated/link.txt"), "install output\n", "utf-8")
    assert.deepEqual(validateVendoredWorkspace(root), [])
  })
})

test("rejects a Windows target package without opentui.dll", () => {
  withFixture((root) => {
    rmSync(join(root, "third_party/npm/@opentui/core-win32-x64/opentui.dll"))
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "missing opentui.dll")
  })
})

test("rejects a target package that declares os/cpu in manifest", () => {
  withFixture((root) => {
    writeJson(join(root, "third_party/npm/@opentui/core-win32-x64/package.json"), {
      name: "@opentui/core-win32-x64",
      version: "0.4.3",
      license: "MIT",
      os: ["win32"],
      cpu: ["x64"],
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "manifest must not declare os/cpu")
  })
})

test("rejects registry resolution for any vendored package", () => {
  withFixture((root) => {
    writeJson(join(root, "package-lock.json"), {
      lockfileVersion: 3,
      packages: Object.fromEntries(
        VENDORED_PACKAGE_SPECS.map((spec) => [
          `node_modules/${spec.name}`,
          { version: spec.version, resolved: `https://npm.intranet.example/${spec.name}/-/${spec.name}-${spec.version}.tgz` },
        ]),
      ),
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "registry fallback")
  })
})

test("rejects a nested registry locator even when the primary record is a workspace link", () => {
  withFixture((root) => {
    writeJson(join(root, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        ...Object.fromEntries(
          VENDORED_PACKAGE_SPECS.map((spec) => [`node_modules/${spec.name}`, { resolved: spec.path, link: true }]),
        ),
        "node_modules/other/node_modules/@opentui/core": {
          version: "0.4.3",
          resolved: "https://npm.intranet.example/@opentui/core/-/core-0.4.3.tgz",
        },
      },
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "@opentui/core: nested registry locator")
  })
})

test("rejects a duplicate root patchedDependencies entry", () => {
  withFixture((root) => {
    writeJson(join(root, "package.json"), {
      name: "fixture",
      workspaces: ["packages/*", "third_party/npm/*", "third_party/npm/@opentui/*"],
      patchedDependencies: { "react-devtools-core@7.0.1": "patches/react-devtools-core@7.0.1.patch" },
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "duplicate root patchedDependencies")
  })
})

test("rejects workspace: protocol residues in any package manifest", () => {
  withFixture((root) => {
    writeJson(join(root, "packages/cli/package.json"), {
      dependencies: {
        "@opentui/core": "workspace:*",
        "@opentui/react": "0.4.3",
      },
      devDependencies: {
        "react-devtools-core": "7.0.1",
      },
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "workspace: protocol is unsupported by npm")
  })
})

test("rejects CLI dependency that does not pin vendored version", () => {
  withFixture((root) => {
    writeJson(join(root, "packages/cli/package.json"), {
      dependencies: {
        "@opentui/core": "0.4.2",
        "@opentui/react": "0.4.3",
      },
      devDependencies: {
        "react-devtools-core": "7.0.1",
      },
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "CLI @opentui/core must pin the vendored version 0.4.3")
  })
})

test("rejects vendored package inter-dependency that does not pin vendored version", () => {
  withFixture((root) => {
    writeJson(join(root, "third_party/npm/@opentui/core/package.json"), {
      name: "@opentui/core",
      version: "0.4.3",
      license: "MIT",
      dependencies: { "bun-ffi-structs": "0.2.3" },
      optionalDependencies: { "@opentui/core-win32-x64": "0.4.3" },
    })
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "@opentui/core -> bun-ffi-structs must pin the vendored version 0.2.4")
  })
})

test("rejects a missing OpenTUI native optional dependency", () => {
  withFixture((root) => {
    const path = join(root, "third_party/npm/@opentui/core/package.json")
    const manifest = JSON.parse(readFileSync(path, "utf-8"))
    delete manifest.optionalDependencies["@opentui/core-darwin-arm64"]
    writeJson(path, manifest)
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "@opentui/core-darwin-arm64: native optional dependency")
  })
})

test("rejects a missing OpenTUI native package lock record", () => {
  withFixture((root) => {
    const path = join(root, "package-lock.json")
    const lock = JSON.parse(readFileSync(path, "utf-8"))
    delete lock.packages["node_modules/@opentui/core-linux-x64"]
    writeJson(path, lock)
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "@opentui/core-linux-x64: missing native optional package in npm lockfile")
  })
})

test("rejects an OpenTUI native lock record with wrong platform metadata", () => {
  withFixture((root) => {
    const path = join(root, "package-lock.json")
    const lock = JSON.parse(readFileSync(path, "utf-8"))
    lock.packages["node_modules/@opentui/core-darwin-x64"].cpu = ["arm64"]
    writeJson(path, lock)
    assertIncludes(validateVendoredWorkspace(root).join("\n"), "@opentui/core-darwin-x64: invalid native optional package in npm lockfile")
  })
})

test("accepts every OpenTUI execution platform", () => {
  for (const [platform, arch, linuxLibc] of [
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
    ["win32", "arm64"],
    ["linux", "x64"],
    ["linux", "arm64", "glibc"],
    ["linux", "x64", "musl"],
    ["linux", "arm64", "musl"],
  ]) {
    assert.deepEqual(validateExecutionPlatform(platform, arch, linuxLibc), [], `${platform}/${arch}/${linuxLibc ?? "default"}`)
  }
})

test("rejects an unsupported OpenTUI platform, architecture, or Linux libc", () => {
  assertIncludes(validateExecutionPlatform("aix", "x64").join("\n"), "不支持")
  assertIncludes(validateExecutionPlatform("darwin", "ia32").join("\n"), "不支持")
  assertIncludes(validateExecutionPlatform("linux", "x64", "uclibc").join("\n"), "OPENTUI_LIBC")
})

test("does not report an installed resolution before node_modules exists", () => {
  withFixture((root) => assert.deepEqual(validateInstalledVendoredWorkspace(root), []))
})

test("accepts installed package links that resolve to the vendored directories", () => {
  withFixture((root) => {
    linkInstalledPackages(root)
    assert.deepEqual(validateInstalledVendoredWorkspace(root), [])
  })
})

test("rejects an installed package link that resolves outside third_party", () => {
  withFixture((root) => {
    linkInstalledPackages(root)
    const link = join(root, "packages/cli/node_modules/react-devtools-core")
    rmSync(link)
    const external = join(root, "registry/react-devtools-core")
    mkdirSync(external, { recursive: true })
    symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir")
    assertIncludes(validateInstalledVendoredWorkspace(root).join("\n"), "must resolve to third_party")
  })
})

test("accepts the installed OpenTUI native package selected for macOS", () => {
  withFixture((root) => {
    installOpenTuiNativePackage(root, "darwin", "arm64")
    assert.deepEqual(validateInstalledOpenTuiNativePackage(root, "darwin", "arm64", undefined, true), [])
  })
})

test("accepts the vendored OpenTUI native package selected for Windows x64", () => {
  withFixture((root) => {
    linkInstalledPackages(root)
    assert.deepEqual(validateInstalledOpenTuiNativePackage(root, "win32", "x64", undefined, true), [])
  })
})

test("accepts the installed OpenTUI musl package selected for Linux", () => {
  withFixture((root) => {
    installOpenTuiNativePackage(root, "linux", "x64", "musl")
    assert.deepEqual(validateInstalledOpenTuiNativePackage(root, "linux", "x64", "musl", true), [])
  })
})

test("rejects a missing installed OpenTUI native package", () => {
  withFixture((root) => {
    assertIncludes(
      validateInstalledOpenTuiNativePackage(root, "darwin", "arm64", undefined, true).join("\n"),
      "@opentui/core-darwin-arm64: installed native package missing",
    )
  })
})

test("rejects an installed OpenTUI native package with wrong identity or platform metadata", () => {
  withFixture((root) => {
    const { packageRoot } = installOpenTuiNativePackage(root, "darwin", "arm64")
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"))
    manifest.version = "0.4.2"
    manifest.cpu = ["x64"]
    writeJson(join(packageRoot, "package.json"), manifest)
    const issues = validateInstalledOpenTuiNativePackage(root, "darwin", "arm64", undefined, true).join("\n")
    assertIncludes(issues, "wrong package identity")
    assertIncludes(issues, "platform metadata")
  })
})

test("rejects an installed OpenTUI native package without its Bun entry or native library", () => {
  withFixture((root) => {
    const { packageRoot, spec } = installOpenTuiNativePackage(root, "darwin", "x64")
    rmSync(join(packageRoot, "index.bun.js"))
    rmSync(join(packageRoot, `opentui${spec.extension}`))
    const issues = validateInstalledOpenTuiNativePackage(root, "darwin", "x64", undefined, true).join("\n")
    assertIncludes(issues, "missing required file: index.bun.js")
    assertIncludes(issues, "missing non-empty native library")
  })
})
