/** 独立临时仓库验证轮次快照、保护快照和本机工作树隔离。 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { inspectDirectory } from "../src/main/local-directory-grants.ts"
import { CodeCheckpoints } from "../src/main/project-service/checkpoints.ts"

const scope = { accountId: "user", workspaceId: "team", projectId: "project", conversationId: "mine" }
const current = () => true
const noOthers = async () => []
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

test("轮次 Diff、回退和保护快照可跨重开访问，保留 HEAD、暂存区与忽略文件", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "hc234-git-"))
  try {
    const root = join(scratch, "repo"), linked = join(scratch, "linked"), data = join(scratch, "checkpoints")
    await mkdir(root)
    git(root, "init", "-q")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    await writeFile(join(root, "code file.txt"), "base\r\n")
    await writeFile(join(root, ".gitignore"), "*.ignored\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "base")
    git(root, "worktree", "add", "-qb", "isolated", linked)
    const grant = await inspectDirectory(linked)
    const checkpoints = new CodeCheckpoints(data, "fixture")
    await checkpoints.register(scope, grant)
    const start = await checkpoints.begin(scope, grant)
    assert.ok(start?.base, start?.unavailable)
    await writeFile(join(linked, "code file.txt"), "after\n")
    await writeFile(join(linked, "image.bin"), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(linked, "keep.ignored"), "untouched")
    git(linked, "add", "--", "code file.txt")
    const indexPath = git(linked, "rev-parse", "--path-format=absolute", "--git-path", "index")
    const index = await readFile(indexPath)
    const head = git(linked, "rev-parse", "HEAD")
    const turnId = randomUUID()
    await checkpoints.finish(start, turnId, Date.now(), "completed", true)

    const reopened = new CodeCheckpoints(data, "fixture")
    const changes = await reopened.run(scope, grant, { kind: "changes", turnId }, current, noOthers)
    assert.deepEqual(changes, { kind: "changes", files: [
      { path: "code file.txt", added: 1, removed: 1 }, { path: "image.bin", added: null, removed: null },
    ] })
    const diff = await reopened.run(scope, grant, { kind: "diff", turnId, path: "code file.txt" }, current, noOthers)
    assert.ok(diff.kind === "diff" && diff.text.includes("+after"))
    const preview = await reopened.run(scope, grant, { kind: "preview", turnId, target: "base" }, current, noOthers)
    assert.ok(preview.kind === "preview" && preview.paths.includes("code file.txt"))
    await writeFile(join(linked, "code file.txt"), "external change\n")
    const restore = { kind: "restore", token: preview.token } as const
    await assert.rejects(reopened.run(scope, grant, restore, current, noOthers), /发生变化/)
    assert.equal(await readFile(join(linked, "code file.txt"), "utf8"), "external change\n")

    const retry = await reopened.run(scope, grant, { kind: "preview", turnId, target: "base" }, current, noOthers)
    assert.ok(retry.kind === "preview")
    const restored = await reopened.run(scope, grant, { kind: "restore", token: retry.token }, current, noOthers)
    assert.deepEqual(restored, { kind: "restored", paths: ["code file.txt", "image.bin"] })
    assert.equal(await readFile(join(linked, "code file.txt"), "utf8"), "base\r\n")
    assert.equal(await readFile(join(linked, "keep.ignored"), "utf8"), "untouched")
    assert.deepEqual(await readFile(indexPath), index)
    assert.equal(git(linked, "rev-parse", "HEAD"), head)

    const history = await reopened.run(scope, grant, { kind: "history" }, current, noOthers)
    assert.equal(history.kind, "history")
    const guardId = history.turns[0].guards[0].id
    const guard = await reopened.run(scope, grant, { kind: "preview", turnId, target: "guard", guardId }, current, noOthers)
    assert.ok(guard.kind === "preview")
    await reopened.run(scope, grant, { kind: "restore", token: guard.token }, current, noOthers)
    assert.equal(await readFile(join(linked, "code file.txt"), "utf8"), "external change\n")

    const partialPreview = await reopened.run(scope, grant, { kind: "preview", turnId, target: "base" }, current, noOthers)
    assert.ok(partialPreview.kind === "preview")
    const noLongerAuthorized = () => readFileSync(join(linked, "code file.txt"), "utf8") !== "base\r\n"
    const partial = await reopened.run(scope, grant, { kind: "restore", token: partialPreview.token }, noLongerAuthorized, noOthers)
    assert.ok(partial.kind === "restored" && partial.failure?.includes("会话已变化"))
    assert.deepEqual(partial.paths, ["code file.txt"])
    assert.deepEqual(await readFile(join(linked, "image.bin")), Buffer.from([0, 1, 2, 3]))
    const guarded = await reopened.run(scope, grant, { kind: "history" }, current, noOthers)
    assert.ok(guarded.kind === "history" && guarded.turns[0].guards.length > 1)

    await reopened.register({ ...scope, conversationId: "other" }, grant)
    await assert.rejects(reopened.run(scope, grant, { kind: "preview", turnId, target: "post" }, current, noOthers), /重叠目录/)
    assert.equal((await reopened.run(scope, grant, { kind: "changes", turnId }, current, noOthers)).kind, "changes")
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test("目标与现有忽略文件冲突时拒绝写入，非 Git 轮次只记录降级原因", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "hc234-git-conflict-"))
  try {
    const root = join(scratch, "repo"), linked = join(scratch, "linked")
    await mkdir(root)
    git(root, "init", "-q")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "commit", "--allow-empty", "-qm", "base")
    git(root, "worktree", "add", "-qb", "isolated", linked)
    const grant = await inspectDirectory(linked)
    const checkpoints = new CodeCheckpoints(join(scratch, "index"), "fixture")
    await checkpoints.register(scope, grant)
    await writeFile(join(linked, "config.local"), "old visible")
    const start = await checkpoints.begin(scope, grant)
    assert.ok(start?.base, start?.unavailable)
    await writeFile(join(linked, ".gitignore"), "config.local\n")
    await writeFile(join(linked, "config.local"), "ignored local value")
    const turnId = randomUUID()
    await checkpoints.finish(start, turnId, Date.now(), "failed", true)
    await assert.rejects(checkpoints.run(scope, grant, { kind: "preview", turnId, target: "base" }, current, noOthers), /忽略文件/)
    assert.equal(await readFile(join(linked, "config.local"), "utf8"), "ignored local value")

    const nongit = await inspectDirectory(scratch)
    const next = await checkpoints.begin(scope, nongit)
    assert.match(next?.unavailable ?? "", /仅在 Git/)
    await checkpoints.finish(next!, randomUUID(), Date.now(), "completed", true)
    const result = await checkpoints.run(scope, nongit, { kind: "history" }, current, noOthers)
    assert.ok(result.kind === "history" && result.turns[0].unavailable?.includes("仅在 Git"))
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
