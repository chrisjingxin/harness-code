/**
 * HC-218 本机工作目录只读宿主单元测试：
 * 覆盖未登录拒绝、普通非 Git 文件夹浏览/@ 候选/预览/平静降级、防 ../ 及符号链接逃逸与 .git 拦截、
 * 二进制文件拒绝、以及 Git 仓库只读差异与跨账号绑定隔离。
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
