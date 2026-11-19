/**
 * HC-218 本机工作目录只读宿主单元测试：
 * 覆盖未登录拒绝、普通非 Git 文件夹浏览/@ 候选/预览/平静降级、防 ../ 及符号链接逃逸与 .git 拦截、
 * 二进制文件拒绝、以及 Git 仓库只读差异与跨账号绑定隔离。
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { LocalDirectoryService } from "../src/main/local-directory-host.ts"

let tempRoot = ""
let plainDir = ""
let gitDir = ""
let outsideFile = ""

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "hc218-local-dir-"))
  plainDir = join(tempRoot, "plain-project")
  gitDir = join(tempRoot, "git-project")
  outsideFile = join(tempRoot, "secret.txt")

  writeFileSync(outsideFile, "TOP_SECRET", "utf8")

  mkdirSync(join(plainDir, "src"), { recursive: true })
  mkdirSync(join(plainDir, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(plainDir, "README.md"), "# Ordinary Project\nLine 2\n", "utf8")
  writeFileSync(join(plainDir, "src", "app.ts"), "export const answer = 42\n", "utf8")
  writeFileSync(join(plainDir, "node_modules", "pkg", "index.js"), "ignored", "utf8")
  writeFileSync(join(plainDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  symlinkSync(outsideFile, join(plainDir, "escape-link.txt"))

  mkdirSync(join(gitDir, "docs"), { recursive: true })
  writeFileSync(join(gitDir, "docs", "guide.md"), "# Guide\n", "utf8")
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

test("未登录时拒绝绑定和读取本机目录", async () => {
  const service = new LocalDirectoryService(() => null)
  const bindRes = await service.bindDirectory("ws-1", "proj-1", "draft-new", plainDir)
  assert.equal(bindRes.ok, false)
  if (!bindRes.ok) assert.equal(bindRes.error.code, "AUTHENTICATION_REQUIRED")
})

test("普通非 Git 目录支持浏览、@ 候选检索、正文预览且 gitStatus 平静降级", async () => {
  const service = new LocalDirectoryService(() => "user-1")
  const bindRes = await service.bindDirectory("ws-1", "proj-1", "conv-1", plainDir)
  assert.equal(bindRes.ok, true)
  if (!bindRes.ok) return
  assert.equal(bindRes.value.isGitRepository, false)

  const rootList = await service.readDirectory("ws-1", "proj-1", "conv-1", {
    kind: "listDirectory",
    directory: "",
  })
  assert.equal(rootList.ok, true)
  if (rootList.ok && rootList.value.kind === "listDirectory") {
    const names = rootList.value.value.entries.map(item => item.name)
    assert.ok(names.includes("src"))
    assert.ok(names.includes("README.md"))
    assert.ok(!names.includes("node_modules"))
  }

  const searchRes = await service.readDirectory("ws-1", "proj-1", "conv-1", {
    kind: "searchCandidates",
    directory: "",
    query: "app",
    limit: 20,
  })
  assert.equal(searchRes.ok, true)
  if (searchRes.ok && searchRes.value.kind === "searchCandidates") {
    assert.deepEqual(searchRes.value.value.items.map(item => item.path), ["src/app.ts"])
  }

  const previewRes = await service.readDirectory("ws-1", "proj-1", "conv-1", {
    kind: "readPreview",
    path: "src/app.ts",
  })
  assert.equal(previewRes.ok, true)
  if (previewRes.ok && previewRes.value.kind === "readPreview") {
    assert.ok(previewRes.value.value.content.includes("answer = 42"))
    assert.equal(previewRes.value.value.language, "typescript")
  }

  const gitStatusRes = await service.readDirectory("ws-1", "proj-1", "conv-1", { kind: "gitStatus" })
  assert.equal(gitStatusRes.ok, true)
  if (gitStatusRes.ok && gitStatusRes.value.kind === "gitStatus") {
    assert.deepEqual(gitStatusRes.value.value.files, [])
    assert.ok(gitStatusRes.value.value.blockedReason?.includes("不是 Git 仓库"))
  }
})

test("严格拒绝 ../ 逃逸、.git 目录读取、符号链接逃逸和二进制正文预览", async () => {
  const service = new LocalDirectoryService(() => "user-1")
  await service.bindDirectory("ws-1", "proj-1", "conv-1", gitDir)

  const dotdot = await service.readDirectory("ws-1", "proj-1", "conv-1", {
    kind: "readPreview",
    path: "../secret.txt",
  })
  assert.equal(dotdot.ok, false)
  if (!dotdot.ok) assert.equal(dotdot.error.code, "PROJECT_PATH_INVALID")

  const dotGit = await service.readDirectory("ws-1", "proj-1", "conv-1", {
    kind: "readPreview",
    path: ".git/HEAD",
  })
  assert.equal(dotGit.ok, false)
  if (!dotGit.ok) assert.equal(dotGit.error.code, "PROJECT_PATH_INVALID")

  await service.bindDirectory("ws-1", "proj-1", "conv-plain", plainDir)
  const symlinkEscape = await service.readDirectory("ws-1", "proj-1", "conv-plain", {
    kind: "readPreview",
    path: "escape-link.txt",
  })
  assert.equal(symlinkEscape.ok, false)
  if (!symlinkEscape.ok) assert.equal(symlinkEscape.error.code, "PROJECT_FILE_DENIED")

  const binary = await service.readDirectory("ws-1", "proj-1", "conv-plain", {
    kind: "readPreview",
    path: "binary.bin",
  })
  assert.equal(binary.ok, false)
  if (!binary.ok) assert.equal(binary.error.code, "PROJECT_FILE_UNSUPPORTED")
})

test("Git 仓库暴露只读变更列表与 diff 并按账号隔离绑定", async () => {
  let activeAccount: string | null = "user-1"
  const service = new LocalDirectoryService(() => activeAccount)

  const bindRes = await service.bindDirectory("ws-1", "proj-1", "conv-git", gitDir)
  assert.equal(bindRes.ok, true)
  if (!bindRes.ok) return
  assert.equal(bindRes.value.isGitRepository, true)

  const statusRes = await service.readDirectory("ws-1", "proj-1", "conv-git", { kind: "gitStatus" })
  assert.equal(statusRes.ok, true)
  if (!statusRes.ok || statusRes.value.kind !== "gitStatus") return
  assert.equal(statusRes.value.value.blockedReason, null)
  assert.deepEqual(
    statusRes.value.value.files.map(file => file.path),
    ["docs/guide.md", "new-note.txt"],
  )

  const diffRes = await service.readDirectory("ws-1", "proj-1", "conv-git", {
    kind: "gitDiff",
    snapshot: statusRes.value.value.snapshot,
    path: "docs/guide.md",
  })
  assert.equal(diffRes.ok, true)
  if (diffRes.ok && diffRes.value.kind === "gitDiff") {
    assert.ok(diffRes.value.value.text.includes("+Updated line"))
  }

  // 切换登录账号后旧账号绑定的目录不可跨账号读取。
  activeAccount = "user-2"
  const crossAccount = await service.readDirectory("ws-1", "proj-1", "conv-git", {
    kind: "listDirectory",
    directory: "",
  })
  assert.equal(crossAccount.ok, false)
  if (!crossAccount.ok) assert.equal(crossAccount.error.code, "RESOURCE_NOT_FOUND")
})

// HC-199 收敛到通用包后，保留桌面与通用包原先有差异的目录范围和展示行为。
test("普通目录与仓库子目录的搜索只返回指定目录内候选，空目录与忽略文件仍可浏览", async () => {
  const service = new LocalDirectoryService(() => "user-1")
  for (const root of [plainDir, gitDir]) {
    mkdirSync(join(root, "scope", "empty"), { recursive: true })
    mkdirSync(join(root, "other"), { recursive: true })
    writeFileSync(join(root, "scope", "match.txt"), "scoped\n")
    writeFileSync(join(root, "other", "match.txt"), "outside scope\n")
    writeFileSync(join(root, "scope", "ignored.txt"), "explicitly browsable\n")
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n")
    await service.bindDirectory("ws-1", "proj-1", "conv", root)
    const found = await service.readDirectory("ws-1", "proj-1", "conv", {
      kind: "searchCandidates", directory: "scope", query: "match",
    })
    assert.ok(found.ok && found.value.kind === "searchCandidates")
    assert.deepEqual(found.value.value.items.map(item => item.path), ["scope/match.txt"])

    const list = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "listDirectory", directory: "scope" })
    assert.ok(list.ok && list.value.kind === "listDirectory")
    assert.deepEqual(list.value.value.entries.map(item => item.name), ["empty", "ignored.txt", "match.txt"])
  }
  const binding = await service.bindDirectory("ws-1", "proj-1", "subdir", join(gitDir, "scope"))
  assert.ok(binding.ok)
  assert.equal(binding.value.isGitRepository, false)
  const found = await service.readDirectory("ws-1", "proj-1", "subdir", {
    kind: "searchCandidates", directory: "", query: "ignored",
  })
  assert.ok(found.ok && found.value.kind === "searchCandidates")
  assert.deepEqual(found.value.value.items.map(item => item.path), ["ignored.txt"])
  const preview = await service.readDirectory("ws-1", "proj-1", "subdir", { kind: "readPreview", path: "match.txt" })
  assert.ok(preview.ok && preview.value.kind === "readPreview")
  assert.equal(preview.value.value.content, "scoped\n")
  const status = await service.readDirectory("ws-1", "proj-1", "subdir", { kind: "gitStatus" })
  assert.ok(status.ok && status.value.kind === "gitStatus")
  assert.equal(status.value.value.snapshot, "non-git")
})

test("有界分页和预览截断保留元数据，目录变化后旧游标失效", async () => {
  const service = new LocalDirectoryService(() => "user-1")
  mkdirSync(join(plainDir, "many"))
  for (let i = 0; i < 513; i++) writeFileSync(join(plainDir, "many", `${i}.txt`), "row")
  writeFileSync(join(plainDir, "large.md"), "中文😀\n".repeat(40_000))
  await service.bindDirectory("ws-1", "proj-1", "conv", plainDir)
  const first = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "listDirectory", directory: "many" })
  assert.ok(first.ok && first.value.kind === "listDirectory")
  assert.equal(first.value.value.entries.length, 512)
  assert.equal(first.value.value.truncated, false)
  assert.ok(first.value.value.nextCursor)
  const cursor = first.value.value.nextCursor
  const last = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "listDirectory", directory: "many", cursor })
  assert.ok(last.ok && last.value.kind === "listDirectory")
  assert.equal(last.value.value.entries.length, 1)
  assert.equal(last.value.value.nextCursor, undefined)
  writeFileSync(join(plainDir, "many", "new.txt"), "new")
  const expired = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "listDirectory", directory: "many", cursor })
  assert.ok(!expired.ok)
  assert.equal(expired.error.code, "PROJECT_CURSOR_EXPIRED")
  const preview = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "readPreview", path: "large.md" })
  assert.ok(preview.ok && preview.value.kind === "readPreview")
  assert.equal(preview.value.value.truncated, true)
  assert.equal(preview.value.value.displayedBytes, Buffer.byteLength(preview.value.value.content))
  assert.ok(preview.value.value.displayedBytes < preview.value.value.sizeBytes)
  assert.ok(!preview.value.value.content.includes("�"))
})

test("Git 管理目录及其别名不可读，普通根内文件链接仍能预览而目录链接不可展开", async () => {
  const root = join(tempRoot, "separate-git")
  const metadata = join(root, "private-metadata")
  mkdirSync(root)
  execFileSync("git", ["init", "-q", `--separate-git-dir=${metadata}`], { cwd: root })
  symlinkSync(metadata, join(root, "metadata-link"))
  writeFileSync(join(root, "safe.txt"), "safe\n")
  symlinkSync(join(root, "safe.txt"), join(root, "file-link"))
  mkdirSync(join(root, "folder"))
  symlinkSync(join(root, "folder"), join(root, "directory-link"))
  const service = new LocalDirectoryService(() => "user-1")
  await service.bindDirectory("ws-1", "proj-1", "conv", root)
  const list = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "listDirectory", directory: "" })
  assert.ok(list.ok && list.value.kind === "listDirectory")
  assert.ok(!list.value.value.entries.some(item => item.path === "private-metadata"))
  for (const path of ["private-metadata/HEAD", "metadata-link/HEAD"]) {
    const denied = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "readPreview", path })
    assert.ok(!denied.ok)
    assert.equal(denied.error.code, "PROJECT_FILE_DENIED")
  }
  const linked = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "readPreview", path: "file-link" })
  assert.ok(linked.ok && linked.value.kind === "readPreview")
  assert.equal(linked.value.value.content, "safe\n")
  const denied = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "listDirectory", directory: "directory-link" })
  assert.ok(!denied.ok)
  assert.equal(denied.error.code, "PROJECT_FILE_DENIED")
})

test("内容变化但 porcelain 状态未变时旧 Git 快照仍被拒绝，未跟踪文件可查看 Diff", async () => {
  const service = new LocalDirectoryService(() => "user-1")
  await service.bindDirectory("ws-1", "proj-1", "conv", gitDir)
  const status = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "gitStatus" })
  assert.ok(status.ok && status.value.kind === "gitStatus")
  const snapshot = status.value.value.snapshot
  const newFile = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "gitDiff", snapshot, path: "new-note.txt" })
  assert.ok(newFile.ok && newFile.value.kind === "gitDiff")
  assert.ok(newFile.value.value.text.includes("+untracked note"))
  writeFileSync(join(gitDir, "docs", "guide.md"), "# Guide\nDifferent line\n")
  const stale = await service.readDirectory("ws-1", "proj-1", "conv", { kind: "gitDiff", snapshot, path: "docs/guide.md" })
  assert.ok(!stale.ok)
  assert.equal(stale.error.code, "PROJECT_GIT_STALE")
})


test("绑定根被替换后文件与非 Git 状态读取均拒绝跟随同名新目录", async () => {
  const service = new LocalDirectoryService(() => "user-1")
  await service.bindDirectory("ws-1", "proj-1", "conv", plainDir)
  renameSync(plainDir, `${plainDir}-previous`)
  mkdirSync(plainDir)
  writeFileSync(join(plainDir, "README.md"), "replacement")
  for (const action of [{ kind: "readPreview", path: "README.md" }, { kind: "gitStatus" }] as const) {
    const result = await service.readDirectory("ws-1", "proj-1", "conv", action)
    assert.ok(!result.ok)
    assert.equal(result.error.code, "PROJECT_ROOT_CHANGED")
  }
})
