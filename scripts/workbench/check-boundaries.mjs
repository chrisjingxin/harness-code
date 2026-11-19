/**
 * 五层架构依赖边界与已退役路径防回流检查（HC-231）：
 * 已退役路径禁止回流 → 根 4-workspace 清单/锁 → 包依赖矩阵与子入口 → `desktop/src/{ui,renderer,shared,preload}` 隔离 → 零特定 Agent 硬编码。
 */
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const allowed = {
  "packages/collaboration-client": [],
  "packages/acp-runtime": [],
  "packages/harness-acp": ["@workbench/acp-runtime"],
  "desktop": ["@workbench/collaboration-client", "@workbench/acp-runtime", "@workbench/harness-acp"],
}

const forbidden = /(?:@za38\/|@opentui\/|bun-ffi-structs|react-devtools-core|za38-agent|deepagents|@workbench\/contracts|@workbench\/ui|@workbench\/project-service|@workbench\/harness-provider|@workbench\/pi-provider|@workbench\/qwen-provider)/
const acpAgentHardcoding = /(?:@workbench\/harness-acp|\bharness[-_]agent\b|\bharnessCode\b|\bpi-acp\b|\bqwen-acp\b)/i

const retiredPaths = [
  "apps",
  "services",
  "examples",
  "packages/workbench-contracts",
  "packages/workbench-ui",
  "packages/project-service",
  "packages/providers",
  "packages/agent",
  "packages/cli",
  "packages/protocol",
  "packages/runner-core",
  "apps/runner",
  "third_party",
  "patches",
  "scripts/install",
  "scripts/dependencies",
  "scripts/e2e-pty.py",
  "scripts/workbench/run-runner-host-smoke.mjs",
]

/** Git 删除源码后本地工作区可能残留被 `.gitignore` 忽略的历史构建或缓存目录，不视为源码回流。 */
const ignoredRetiredEntries = new Set([
  "node_modules",
  "dist",
  "out",
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".publish",
  ".test-tree-sitter",
  ".claude",
  ".DS_Store",
])

const toPosix = value => value.replaceAll("\\", "/")

async function hasNonIgnoredRetiredContent(targetPath) {
  let stats
  try {
    stats = await lstat(targetPath)
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
  if (!stats.isDirectory()) return true
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    if (ignoredRetiredEntries.has(entry.name)) continue
    if (!entry.isDirectory()) return true
    if (await hasNonIgnoredRetiredContent(join(targetPath, entry.name))) return true
  }
  return false
}

function validateRetiredPaths(existingPaths) {
  for (const retiredPath of retiredPaths) {
    if (existingPaths.has(retiredPath)) throw new Error(`禁止回流已退役路径: ${retiredPath}`)
  }
}

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
/** node: 前缀在 Node 新版本中可能尚未进入 builtinModules（如 node:sqlite）；仍按内建处理。 */
const isBuiltin = specifier => builtins.has(specifier) || specifier.startsWith("node:")
const inside = (path, base) => { const rel = relative(base, path); return !rel.startsWith("..") && !isAbsolute(rel) }
const loadJson = async path => JSON.parse(await readFile(path, "utf8"))

/** 入口检查使用目标包 exports 的实际声明，支持显式子入口及声明的通配入口。 */
function publicEntry(exports, entry) {
  if (typeof exports === "string" || Array.isArray(exports)) return entry === "."
  if (!exports || typeof exports !== "object") return false
  const keys = Object.keys(exports)
  if (!keys.some(key => key.startsWith("."))) return entry === "."
  return keys.some(key => {
    if (exports[key] === null) return false
    if (!key.includes("*")) return key === entry
    const [start, end] = key.split("*")
    return entry.startsWith(start) && entry.endsWith(end) && entry.length >= start.length + end.length
  })
}

function validateImport(specifier, file, owner, packages) {
  if (forbidden.test(specifier)) throw new Error("禁止已退役产品、包名或可选 Harness 内核依赖")
  const relFile = toPosix(relative(owner.directory, file))
  const inUi = relFile.startsWith("src/ui/")
  const inRenderer = relFile.startsWith("src/renderer/")
  const inShared = relFile.startsWith("src/shared/")
  const inPreload = relFile.startsWith("src/preload/")
  const isDesktopBrowserLayer = owner.path === "desktop" && (inUi || inRenderer || inShared)
  const isDesktopNonMainRuntime = owner.path === "desktop" && (inUi || inRenderer || inShared || inPreload)

  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const resolvedTarget = resolve(dirname(file), specifier)
    if (!inside(resolvedTarget, owner.directory)) throw new Error("跨包相对路径必须改用公开入口")
    if (owner.path === "desktop") {
      const relTarget = toPosix(relative(owner.directory, resolvedTarget))
      if (isDesktopBrowserLayer && (relTarget.startsWith("src/main/") || relTarget === "src/main" || relTarget.startsWith("src/preload/") || relTarget === "src/preload")) {
        throw new Error("desktop/src/{ui,renderer,shared} 严禁导入 main 或 preload")
      }
      if (inUi && (relTarget.startsWith("src/renderer/") || relTarget === "src/renderer")) {
        throw new Error("desktop/src/ui 严禁反向导入 renderer")
      }
      if (inPreload && (relTarget.startsWith("src/main/") || relTarget === "src/main")) {
        throw new Error("desktop/src/preload 严禁直接导入 main")
      }
    }
    return
  }

  if (specifier.startsWith("#")) throw new Error("不允许用 package imports 别名绕过边界")

  const isPureTypesFile =
    (owner.path === "packages/collaboration-client" && relFile.startsWith("src/types/"))
    || (owner.path === "packages/acp-runtime" && (relFile === "src/types.ts" || relFile === "src/descriptor.ts"))

  if (specifier === "electron" && owner.path !== "desktop") {
    throw new Error(`${owner.path} 禁止依赖 electron`)
  }
  if (specifier === "electron" && isDesktopBrowserLayer) {
    throw new Error("desktop/src/{ui,renderer,shared} 不能访问 Electron")
  }
  if (isBuiltin(specifier) && (isPureTypesFile || isDesktopBrowserLayer)) {
    throw new Error("纯类型入口及 UI/Renderer/Shared 不能访问 Node 内置模块")
  }
  if (isBuiltin(specifier)) return

  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
  const declarations = { ...owner.manifest.dependencies, ...owner.manifest.devDependencies, ...owner.manifest.peerDependencies }
  if (!(name in declarations)) throw new Error(`未声明依赖 ${name}`)

  const target = packages.get(name)
  if (target) {
    const suffix = specifier.slice(name.length)
    const entry = suffix ? `.${suffix}` : "."
    if (!publicEntry(target.manifest.exports, entry)) throw new Error(`未声明公开入口 ${specifier}`)
    if (!allowed[owner.path].includes(name)) throw new Error(`禁止反向依赖 ${name}`)
    if (isDesktopNonMainRuntime) {
      if (name === "@workbench/harness-acp") {
        throw new Error(`${name} 只能在桌面主进程装配`)
      }
      if ((name === "@workbench/acp-runtime" || name === "@workbench/collaboration-client") && entry !== "./types") {
        throw new Error(`${name} 在非主进程层仅允许使用 ${name}/types`)
      }
    }
  }
}

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "out"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) result.push(path)
  }
  return result
}

/** 检查失败会携带文件和行号，供开发者直接定位。 */
async function check() {
  const existingRetired = new Set()
  for (const retiredPath of retiredPaths) {
    if (await hasNonIgnoredRetiredContent(join(root, retiredPath))) existingRetired.add(retiredPath)
  }
  validateRetiredPaths(existingRetired)

  const manifest = await loadJson(join(root, "package.json"))
  assert.deepEqual(manifest.workspaces, Object.keys(allowed), "根 workspace 必须是四个显式目录")

  const packages = new Map()
  for (const path of manifest.workspaces) {
    const entry = { path, directory: join(root, path), manifest: await loadJson(join(root, path, "package.json")) }
    packages.set(entry.manifest.name, entry)
  }

  for (const owner of packages.values()) {
    const dependencies = { ...owner.manifest.dependencies, ...owner.manifest.devDependencies, ...owner.manifest.peerDependencies, ...owner.manifest.optionalDependencies }
    for (const name of Object.keys(dependencies)) {
      if (forbidden.test(name) || String(dependencies[name]).startsWith("file:")) throw new Error(`${owner.path}: 禁止依赖 ${name}`)
      if (packages.has(name) && !allowed[owner.path].includes(name)) throw new Error(`${owner.path}: 禁止反向依赖 ${name}`)
    }
    function validateExports(value) {
      if (typeof value === "string" && (!value.startsWith("./") || !inside(resolve(owner.directory, value), owner.directory))) throw new Error(`${owner.path}: exports 不能指向包外`)
      if (value && typeof value === "object") for (const child of Object.values(value)) validateExports(child)
    }
    validateExports(owner.manifest.exports)
    if (owner.manifest.imports) throw new Error(`${owner.path}: 不允许 package imports 别名`)

    const config = await loadJson(join(owner.directory, "tsconfig.json"))
    for (const targets of Object.values(config.compilerOptions?.paths ?? {})) {
      if (targets.some(target => !inside(resolve(owner.directory, config.compilerOptions?.baseUrl ?? ".", target), owner.directory))) throw new Error(`${owner.path}: 路径映射跨包`)
    }

    for (const file of await files(owner.directory)) {
      const content = await readFile(file, "utf8")
      const relFile = toPosix(relative(owner.directory, file))
      if (owner.path === "packages/acp-runtime" && relFile.startsWith("src/")) {
        const match = acpAgentHardcoding.exec(content)
        if (match) throw new Error(`${relative(root, file)}: packages/acp-runtime 禁止硬编码特定 Agent 标识 (${match[0]})`)
      }
      const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
      function visit(node) {
        let specifier
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier.text
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
          if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) throw new Error(`${relative(root, file)}: 禁止不可静态确定的模块加载`)
          specifier = node.arguments[0].text
        }
        // 构建 alias 会改变真实模块解析，当前基础工程不允许额外设置。
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === "alias") throw new Error(`${relative(root, file)}: 禁止构建 alias 绕过包导出`)
        if (specifier) {
          try { validateImport(specifier, file, owner, packages) }
          catch (error) { throw new Error(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}: ${error.message}`) }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }

  const lock = await loadJson(join(root, "package-lock.json"))
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry.extraneous) throw new Error(`锁文件包含多余未声明节点: ${path}`)
    if (forbidden.test(path) || (entry.link && !manifest.workspaces.includes(entry.resolved))) throw new Error(`锁文件包含旧/未知依赖: ${path}`)
    if (entry.resolved && !entry.link && !entry.resolved.startsWith("https://registry.npmjs.org/")) throw new Error(`锁文件包含非公开源制品: ${path}`)
  }
  console.log(`依赖边界通过：${packages.size} 个 workspace；锁文件、公开入口、desktop 子层隔离与退役路径已检查。`)
}

async function selfCheck() {
  const packages = new Map([
    ["@workbench/collaboration-client", { manifest: { exports: { ".": "./dist/index.js", "./types": "./dist/types/index.js" } } }],
    ["@workbench/acp-runtime", { manifest: { exports: { ".": "./dist/index.js", "./types": "./dist/types.js" } } }],
    ["@workbench/harness-acp", { manifest: { exports: { ".": "./dist/index.js" } } }],
  ])

  const collabClient = {
    path: "packages/collaboration-client",
    directory: "/project/packages/collaboration-client",
    manifest: { name: "@workbench/collaboration-client", dependencies: { ajv: "8.20.0" } },
  }
  validateImport("node:fs", "/project/packages/collaboration-client/src/collaboration-client.ts", collabClient, packages)
  assert.throws(() => validateImport("node:fs", "/project/packages/collaboration-client/src/types/identity.ts", collabClient, packages))
  assert.throws(() => validateImport("electron", "/project/packages/collaboration-client/src/index.ts", collabClient, packages))

  const acpRuntime = {
    path: "packages/acp-runtime",
    directory: "/project/packages/acp-runtime",
    manifest: { name: "@workbench/acp-runtime", dependencies: { "@agentclientprotocol/sdk": "0.25.1" } },
  }
  validateImport("node:child_process", "/project/packages/acp-runtime/src/session.ts", acpRuntime, packages)
  assert.throws(() => validateImport("node:child_process", "/project/packages/acp-runtime/src/types.ts", acpRuntime, packages))
  assert.throws(() => validateImport("node:fs", "/project/packages/acp-runtime/src/descriptor.ts", acpRuntime, packages))
  assert.throws(() => validateImport("electron", "/project/packages/acp-runtime/src/index.ts", acpRuntime, packages))

  const harnessAcp = {
    path: "packages/harness-acp",
    directory: "/project/packages/harness-acp",
    manifest: { name: "@workbench/harness-acp", dependencies: { "@workbench/acp-runtime": "0.2.0", "@workbench/collaboration-client": "0.2.0" } },
  }
  validateImport("@workbench/acp-runtime", "/project/packages/harness-acp/src/index.ts", harnessAcp, packages)
  assert.throws(() => validateImport("@workbench/collaboration-client", "/project/packages/harness-acp/src/index.ts", harnessAcp, packages))
  assert.throws(() => validateImport("electron", "/project/packages/harness-acp/src/index.ts", harnessAcp, packages))
  assert.throws(() => validateImport("@workbench/contracts", "/project/packages/harness-acp/src/index.ts", harnessAcp, packages))
  assert.throws(() => validateImport("../../acp-runtime/src/index.js", "/project/packages/harness-acp/src/index.ts", harnessAcp, packages))

  const desktop = {
    path: "desktop",
    directory: "/project/desktop",
    manifest: {
      name: "@workbench/desktop",
      dependencies: {
        "@workbench/collaboration-client": "0.2.0",
        "@workbench/acp-runtime": "0.2.0",
        "@workbench/harness-acp": "0.2.0",
      },
      devDependencies: {
        electron: "42.3.0",
      },
    },
  }
  // 主进程可访问三层运行时根入口
  for (const pkg of ["@workbench/collaboration-client", "@workbench/acp-runtime", "@workbench/harness-acp"]) {
    validateImport(pkg, "/project/desktop/src/main/local-acp-host.ts", desktop, packages)
  }
  // ui / renderer / shared / preload 严禁接触 Node/Electron/main/preload 或非 /types 运行时根入口
  validateImport("@workbench/collaboration-client/types", "/project/desktop/src/ui/identity/identity-panel.tsx", desktop, packages)
  validateImport("@workbench/acp-runtime/types", "/project/desktop/src/renderer/features/session/contracts.ts", desktop, packages)
  validateImport("@workbench/acp-runtime/types", "/project/desktop/src/shared/local-execution-host.ts", desktop, packages)
  validateImport("electron", "/project/desktop/src/preload/index.ts", desktop, packages)

  for (const file of [
    "/project/desktop/src/ui/index.ts",
    "/project/desktop/src/renderer/desktop-workbench.tsx",
    "/project/desktop/src/shared/desktop-host.ts",
  ]) {
    assert.throws(() => validateImport("node:fs", file, desktop, packages), undefined, `node:fs -> ${file}`)
    assert.throws(() => validateImport("electron", file, desktop, packages), undefined, `electron -> ${file}`)
    assert.throws(() => validateImport("../main/index.js", file, desktop, packages), undefined, `main -> ${file}`)
    assert.throws(() => validateImport("@workbench/collaboration-client", file, desktop, packages), undefined, `collab -> ${file}`)
    assert.throws(() => validateImport("@workbench/acp-runtime", file, desktop, packages), undefined, `acp -> ${file}`)
    assert.throws(() => validateImport("@workbench/harness-acp", file, desktop, packages), undefined, `harness -> ${file}`)
  }
  assert.throws(() => validateImport("../renderer/main.js", "/project/desktop/src/ui/index.ts", desktop, packages))
  assert.throws(() => validateImport("../main/index.js", "/project/desktop/src/preload/index.ts", desktop, packages))
  assert.throws(() => validateImport("@workbench/acp-runtime", "/project/desktop/src/preload/local-execution-api.ts", desktop, packages))

  assert.equal(publicEntry({ "./types": "./dist/types.js", ".": "./dist/index.js" }, "./types"), true)
  assert.equal(publicEntry({ ".": "./dist/index.js" }, "./private"), false)
  validateRetiredPaths(new Set())
  for (const legacy of ["apps", "services", "examples", "packages/workbench-contracts", "packages/providers", "packages/agent"]) {
    assert.throws(() => validateRetiredPaths(new Set([legacy])), /禁止回流已退役路径/, legacy)
  }

  const tempDir = await mkdtemp(join(tmpdir(), "workbench-retired-check-"))
  try {
    const ignoredOnlyDir = join(tempDir, "ignored-only")
    await mkdir(join(ignoredOnlyDir, "node_modules"), { recursive: true })
    await mkdir(join(ignoredOnlyDir, "dist"), { recursive: true })
    await writeFile(join(ignoredOnlyDir, "dist", "index.js"), "", "utf8")
    assert.equal(await hasNonIgnoredRetiredContent(ignoredOnlyDir), false)
    await writeFile(join(ignoredOnlyDir, "package.json"), "{}", "utf8")
    assert.equal(await hasNonIgnoredRetiredContent(ignoredOnlyDir), true)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
  console.log("边界夹具通过：4-workspace 依赖矩阵、desktop 内部隔离、纯类型隔离与全部退役路径回流检查均正确。")
}

await check()
if (process.argv.includes("--self-check")) await selfCheck()
