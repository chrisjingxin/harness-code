/**
 * 新平台依赖检查：根清单/锁 → 包图 → 源码导入 → 公开入口与宿主边界。
 * 旧目录只作迁移来源，不参与扫描；不能通过相对路径或构建 alias 绕过公开导出。
 */
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { builtinModules } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const allowed = {
  "packages/workbench-contracts": [],
  "packages/runner-core": ["@workbench/contracts"],
  "packages/acp-runtime": ["@workbench/contracts"],
  "packages/project-service": ["@workbench/contracts"],
  "packages/workbench-ui": ["@workbench/contracts"],
  "apps/runner": ["@workbench/runner-core"],
  "apps/desktop": ["@workbench/contracts", "@workbench/ui"],
}
const forbidden = /(?:@za38\/|@opentui\/|bun-ffi-structs|react-devtools-core|za38-agent|harness-provider|deepagents)/
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
  if (forbidden.test(specifier)) throw new Error("禁止旧产品或可选 Harness 依赖")
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    if (!inside(resolve(dirname(file), specifier), owner.directory)) throw new Error("跨包相对路径必须改用公开入口")
    return
  }
  if (specifier.startsWith("#")) throw new Error("不允许用 package imports 别名绕过边界")
  const ui = owner.manifest.name === "@workbench/ui" || file.includes(`${join("src", "renderer")}/`)
  if (isBuiltin(specifier) || specifier === "electron") {
    if (ui || owner.manifest.name === "@workbench/contracts") throw new Error("UI/契约不能访问 Node/Electron")
  }
  if (isBuiltin(specifier)) return
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
  const declarations = { ...owner.manifest.dependencies, ...owner.manifest.devDependencies, ...owner.manifest.peerDependencies }
  if (!(name in declarations)) throw new Error(`未声明依赖 ${name}`)
  const target = packages.get(name)
  if (target) {
    if (!allowed[owner.path].includes(name)) throw new Error(`禁止反向依赖 ${name}`)
    const suffix = specifier.slice(name.length)
    if (!publicEntry(target.manifest.exports, suffix ? `.${suffix}` : ".")) throw new Error(`未声明公开入口 ${specifier}`)
  }
}
async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) result.push(path)
  }
  return result
}
/** 检查失败会携带文件和行号，供开发者直接定位。 */
async function check() {
  const manifest = await loadJson(join(root, "package.json"))
  assert.deepEqual(manifest.workspaces, Object.keys(allowed), "根 workspace 必须是七个显式目录")
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
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true)
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
    if (forbidden.test(path) || (entry.link && !manifest.workspaces.includes(entry.resolved))) throw new Error(`锁文件包含旧/未知依赖: ${path}`)
    if (entry.resolved && !entry.link && !entry.resolved.startsWith("https://registry.npmjs.org/")) throw new Error(`锁文件包含非公开源制品: ${path}`)
  }
  console.log(`依赖边界通过：${packages.size} 个 workspace；锁文件、公开入口与宿主边界已检查。`)
}
function selfCheck() {
  const owner = { path: "packages/runner-core", directory: "/project/core", manifest: { name: "@workbench/runner-core", dependencies: { "@workbench/contracts": "0.2.0", "@workbench/ui": "0.2.0" } } }
  const packages = new Map([["@workbench/contracts", { manifest: { exports: { ".": "./index.js", "./runtime": "./runtime.js" } } }], ["@workbench/ui", { manifest: { exports: { ".": "./index.js" } } }]])
  validateImport("@workbench/contracts/runtime", "/project/core/src/index.ts", owner, packages)
  for (const path of ["@workbench/contracts/private", "@workbench/ui", "@za38/protocol", "../../other/index.js", "missing-package"]) assert.throws(() => validateImport(path, "/project/core/src/index.ts", owner, packages), undefined, path)
  assert.throws(() => validateImport("node:fs", "/project/ui/src/index.ts", { ...owner, manifest: { name: "@workbench/ui" } }, packages))
  assert.equal(publicEntry({ "./runtime": "./dist/runtime.js", "./ui": "./dist/ui.js" }, "./ui"), true)
  console.log("边界夹具通过：声明子入口合法；旧依赖、反向依赖、内部路径、未声明依赖和 UI 宿主访问被拒绝。")
}
await check()
if (process.argv.includes("--self-check")) selfCheck()
