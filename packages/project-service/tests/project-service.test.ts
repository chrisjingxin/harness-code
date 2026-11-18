/**
 * `@workbench/project-service` 只读文件与 Git 服务单元测试：
 * 覆盖写接口下线验证、普通目录浏览/@ 检索/预览、防路径逃逸与符号链接拦截、
 * 非 Git 与 Git 子目录平静降级、Git 只读状态/未跟踪 Diff/分离 HEAD，以及根目录漂移拒绝。
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import type { createProjectService as createProjectServiceFn, ProjectServiceError as ProjectServiceErrorClass } from "../src/index.js"

if (!("bun" in process.versions)) {
  const resolveTsHook = `
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    export async function resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const jsUrl = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(jsUrl))) {
          const tsSpecifier = specifier.slice(0, -3) + ".ts";
          const tsUrl = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsSpecifier, context);
        }
      }
      return nextResolve(specifier, context);
    }
  `
  register(`data:text/javascript,${encodeURIComponent(resolveTsHook)}`)
}

const { createProjectService, ProjectServiceError } = await import("../src/index.ts") as {
  createProjectService: typeof createProjectServiceFn
  ProjectServiceError: typeof ProjectServiceErrorClass
}

let tempRoot = ""
let plainDir = ""
let gitDir = ""
let outsideFile = ""

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "hc228-project-service-"))
  plainDir = join(tempRoot, "plain-project")
  gitDir = join(tempRoot, "git-project")
  outsideFile = join(tempRoot, "secret.txt")

  writeFileSync(outsideFile, "TOP_SECRET", "utf8")

  mkdirSync(join(plainDir, "src", "nested"), { recursive: true })
  mkdirSync(join(plainDir, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(plainDir, "README.md"), "# Ordinary Project\nLine 2\n", "utf8")
  writeFileSync(join(plainDir, "src", "app.ts"), "export const answer = 42\n", "utf8")
  writeFileSync(join(plainDir, "src", "nested", "helper.ts"), "export const helper = true\n", "utf8")
  writeFileSync(join(plainDir, "node_modules", "pkg", "index.js"), "ignored", "utf8")
  writeFileSync(join(plainDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  symlinkSync(outsideFile, join(plainDir, "escape-link.txt"))

  mkdirSync(join(gitDir, "docs"), { recursive: true })
  mkdirSync(join(gitDir, "empty-folder"), { recursive: true })
  mkdirSync(join(gitDir, "sub", "inner"), { recursive: true })
  writeFileSync(join(gitDir, "docs", "guide.md"), "# Guide\n", "utf8")
  writeFileSync(join(gitDir, "sub", "inner", "item.ts"), "export const item = 1\n", "utf8")
  execFileSync("git", ["init", "-q"], { cwd: gitDir })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: gitDir })
  execFileSync("git", ["add", "."], { cwd: gitDir })
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitDir })
  writeFileSync(join(gitDir, "docs", "guide.md"), "# Guide\nUpdated line\n", "utf8")
  writeFileSync(join(gitDir, "new-note.txt"), "untracked note\n", "utf8")
})

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

test("createProjectService 仅暴露只读能力且不提供 commit/push", async () => {
  const service = await createProjectService(plainDir)
  assert.equal("commit" in service, false)
  assert.equal("push" in service, false)
  assert.equal(service.isGitRepository, false)
  assert.equal(typeof service.rootPath, "string")
})

test("普通非 Git 目录支持分页列表、作用域限定 @ 候选检索、预览及平静 gitStatus", async () => {
  const service = await createProjectService(plainDir)
  assert.equal(service.isGitRepository, false)

  const rootList = await service.listDirectory("")
  const names = rootList.entries.map(item => item.name)
  assert.ok(names.includes("src"))
  assert.ok(names.includes("README.md"))
  assert.ok(!names.includes("node_modules"))

  // 限定 directory="src" 时只命中 src 下的候选，不会串入根目录文件
  const scopedSearch = await service.searchCandidates({ directory: "src", query: "e", limit: 20 })
  assert.ok(scopedSearch.items.length >= 1)
  assert.ok(scopedSearch.items.every(item => item.path.startsWith("src/")))

  const appSearch = await service.searchCandidates({ directory: "", query: "app", limit: 20 })
  assert.deepEqual(appSearch.items.map(item => item.path), ["src/app.ts"])
  assert.deepEqual(appSearch.items[0]?.matchRanges, [{ start: 4, end: 7 }])

  const preview = await service.readPreview("src/app.ts")
  assert.ok(preview.content.includes("answer = 42"))
  assert.equal(preview.language, "typescript")
  assert.equal(preview.truncated, false)

  const status = await service.gitStatus()
  assert.equal(status.snapshot, "non-git")
  assert.deepEqual(status.files, [])
  assert.ok(status.blockedReason?.includes("不是 Git 仓库"))

  await assert.rejects(
    () => service.gitDiff({ snapshot: "non-git", path: "README.md" }),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "git-unavailable",
  )
})

test("目录分页游标在目录变动后失效且抛 cursor-expired", async () => {
  const largeDir = join(tempRoot, "large-dir")
  mkdirSync(largeDir, { recursive: true })
  for (let i = 0; i < 600; i++) {
    writeFileSync(join(largeDir, `file-${String(i).padStart(4, "0")}.txt`), "x\n", "utf8")
  }
  const service = await createProjectService(largeDir)
  const page1 = await service.listDirectory("")
  assert.equal(page1.entries.length, 512)
  assert.ok(page1.nextCursor)

  const page2 = await service.listDirectory("", page1.nextCursor)
  assert.equal(page2.entries.length, 88)
  assert.equal(page2.nextCursor, undefined)

  writeFileSync(join(largeDir, "extra.txt"), "new\n", "utf8")
  await assert.rejects(
    () => service.listDirectory("", page1.nextCursor),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "cursor-expired",
  )
})

test("严格拦截 ../ 越界、反斜杠、.git、符号链接逃逸与二进制文件", async () => {
  const service = await createProjectService(plainDir)

  for (const badPath of ["../secret.txt", ".git/HEAD", "src\\app.ts", ""]) {
    await assert.rejects(
      () => service.readPreview(badPath),
      (error: unknown) => error instanceof ProjectServiceError && error.code === "invalid-path",
      badPath,
    )
  }

  await assert.rejects(
    () => service.readPreview("escape-link.txt"),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "outside-project",
  )

  await assert.rejects(
    () => service.readPreview("binary.bin"),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "binary-file",
  )

  // 文件当作目录读取时拒绝
  await assert.rejects(
    () => service.listDirectory("README.md"),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "invalid-path",
  )
})

test("Git 仓库支持只读状态、已修改与未跟踪 Diff、分离 HEAD 以及子目录非仓库隔离", async () => {
  const gitService = await createProjectService(gitDir)
  assert.equal(gitService.isGitRepository, true)

  const rootEntries = await gitService.listDirectory("")
  assert.ok(rootEntries.entries.some(item => item.name === "empty-folder" && item.kind === "directory"))

  const status = await gitService.gitStatus()
  assert.equal(status.blockedReason, null)
  assert.deepEqual(status.files.map(item => item.path), ["docs/guide.md", "new-note.txt"])

  const trackedDiff = await gitService.gitDiff({ snapshot: status.snapshot, path: "docs/guide.md" })
  assert.ok(trackedDiff.text.includes("+Updated line"))

  const untrackedDiff = await gitService.gitDiff({ snapshot: status.snapshot, path: "new-note.txt" })
  assert.ok(untrackedDiff.text.includes("+untracked note"))

  await assert.rejects(
    () => gitService.gitDiff({ snapshot: "stale-snapshot", path: "docs/guide.md" }),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "git-stale",
  )

  // Git 仓库子目录视为非 Git 根目录，gitStatus 平静降级
  const subService = await createProjectService(resolve(gitDir, "sub"))
  assert.equal(subService.isGitRepository, false)
  const subStatus = await subService.gitStatus()
  assert.equal(subStatus.snapshot, "non-git")
  assert.deepEqual(subStatus.files, [])

  // 分离 HEAD 仍可正常读取状态与差异，不标记阻塞
  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: gitDir })
  const detachedStatus = await gitService.gitStatus()
  assert.equal(detachedStatus.branch, null)
  assert.equal(detachedStatus.blockedReason, null)
  const detachedDiff = await gitService.gitDiff({ snapshot: detachedStatus.snapshot, path: "docs/guide.md" })
  assert.ok(detachedDiff.text.includes("+Updated line"))
})

test("绑定目录被删除或替换后触发 root-changed", async () => {
  const doomed = join(tempRoot, "doomed")
  mkdirSync(doomed, { recursive: true })
  writeFileSync(join(doomed, "a.txt"), "hello\n", "utf8")
  const service = await createProjectService(doomed)
  rmSync(doomed, { recursive: true, force: true })
  await assert.rejects(
    () => service.listDirectory(""),
    (error: unknown) => error instanceof ProjectServiceError && error.code === "root-changed",
  )
})
