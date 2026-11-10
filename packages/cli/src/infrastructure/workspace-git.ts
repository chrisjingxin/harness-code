/** 本机 Git adapter：有界参数化执行、快照校验与独立 index，保留未选暂存内容。 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readlink, realpath, open, rename, rm, mkdtemp, copyFile, mkdir, writeFile, chmod } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, dirname, sep } from "node:path"
import type { GitCommitInput, GitDiff, GitFile, GitRepository, WorkspaceGit } from "../interactive/ports/workspace-git"

const MAX_FILES = 1000
const MAX_BYTES = 32 * 1024 * 1024
const DIFF_LIMIT = 96 * 1024
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

/** 仅向用户返回有界、已脱敏的 Git 诊断；不返回命令环境或 remote URL。 */
function safeError(value: string): string {
  return value.replace(/(?:https?|ssh):\/\/[^\s]+/gi, "[远端地址]").replace(/(?:Bearer|token|password|api[_-]?key)[:= ]+[^\s]+/gi, "[凭据已隐藏]").slice(0, 1800)
}
function env(index?: string): NodeJS.ProcessEnv {
  const result = { ...process.env }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete result[key]
  return { ...result, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...(index ? { GIT_INDEX_FILE: index } : {}) }
}
type CommandResult = { code: number; out: string; error: string }
function command(cwd: string, args: string[], options: { index?: string; input?: string; timeout?: number } = {}): Promise<CommandResult> {
  return new Promise((done, reject) => {
    const child = execFile("git", ["--no-pager", ...args], { cwd, env: env(options.index), timeout: options.timeout ?? 15000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== "number" || error.killed)) { reject(new Error("Git 执行超时或不可用；请刷新状态并在终端检查。")); return }
      done({ code: error ? Number(error.code) : 0, out: stdout, error: stderr })
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(options.input)
  })
}
async function run(cwd: string, args: string[], options: { index?: string; input?: string; timeout?: number } = {}): Promise<string> {
  const result = await command(cwd, args, options)
  if (result.code !== 0) throw new Error(`Git 操作失败：${safeError(result.error) || "请在终端检查 Git 配置。"}`)
  return result.out
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error: any) { if (error.code === "ENOENT") return false; throw error } }
async function optional(cwd: string, args: string[]): Promise<string | null> { const result = await command(cwd, args); return result.code === 0 ? result.out.trim() : null }
function validPath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.includes("\0") && !path.includes("\ufffd") && !path.split("/").some(part => part === ".." || part === ".git")
}
/** 不跟随最终 symlink，且拒绝通过父目录链接逃逸到 Git 根以外。 */
async function fingerprint(root: string, path: string, budget: { bytes: number }): Promise<string> {
  if (!validPath(path)) throw new Error("文件路径不可安全表示，请在终端处理。")
  const absolute = resolve(root, path)
  let parent = dirname(absolute)
  while (!await exists(parent)) parent = dirname(parent)
  const resolvedParent = await realpath(parent), delta = relative(root, resolvedParent)
  if (isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`)) throw new Error("文件路径越过 Git 工作区边界。")
  try {
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink()) return hash(`link:${await readlink(absolute)}`)
    if (!stat.isFile() || stat.size > MAX_BYTES || (budget.bytes += stat.size) > MAX_BYTES) throw new Error("变更超过界面可安全处理的大小，或包含特殊文件，请在终端处理。")
    return hash(`${stat.mode & 0o111}:` + hash(await readFile(absolute)))
  } catch (error: any) { if (error.code === "ENOENT") return "deleted"; throw error }
}

/** Shell 只用于 Git 原生 hook 包装脚本；路径逐字单引号转义，业务参数仍只经数组/标准输入。 */
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
/** 保留现有 hooks，但禁止 hook 改写已审阅的暂存树或夹带未选文件。 */
async function guardedHooks(root: string, directory: string, tree: string): Promise<string> {
  const original = resolve(root,(await run(root,["rev-parse","--git-path","hooks"])).trim())
  const hooks = join(directory,"hooks");await mkdir(hooks)
  for (const name of ["pre-commit","prepare-commit-msg","commit-msg","post-commit"]) {
    const path=join(hooks,name), target=shellQuote(join(original,name))
    const verify = name === "post-commit" ? "" : `actual=$(git write-tree) || exit 1\nif [ "$actual" != ${shellQuote(tree)} ]; then\n  echo 'Git hook changed reviewed files; hook 改写了本次暂存内容，请刷新检查后重试。' >&2\n  exit 1\nfi\n`
    await writeFile(path,`#!/bin/sh\nif [ -x ${target} ]; then\n  ${target} "$@" || exit $?\nfi\n${verify}`)
    await chmod(path,0o700)
  }
  return hooks
}

/** 绑定固定启动工作区的本机 Git 实现；所有写入均先校验快照。 */
class LocalWorkspaceGit implements WorkspaceGit {
  constructor(private readonly cwd: string) {}
  private async root(): Promise<string> {
    const root = await optional(this.cwd, ["rev-parse", "--show-toplevel"])
    if (!root) throw new Error("当前目录不是可用的 Git 工作区，请先在终端初始化或检查仓库。")
    return realpath(root)
  }
  /** 读取 Git 根、分支、变更和索引/内容摘要，不刷新或改写用户暂存区。 */
  async status(): Promise<GitRepository> {
    const root = await this.root()
    const gitDir = (await run(root, ["rev-parse", "--absolute-git-dir"])).trim()
    const head = await optional(root, ["rev-parse", "--verify", "HEAD"])
    const branch = await optional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    let blockedReason: string | null = branch ? null : "当前为 detached HEAD，请先在终端切换到分支。"
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer"]) {
      if (await exists(join(gitDir, name))) blockedReason = "Git 合并、变基或拣选操作进行中，请先在终端完成。"
    }
    const stages = await run(root, ["ls-files", "--stage", "-z"])
    if (stages.split("\0").some(row => row.startsWith("160000 "))) blockedReason = "仓库含子模块，请在终端提交。"
    const raw = await run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])
    const records = raw.split("\0"), files: GitFile[] = [], budget = { bytes: 0 }
    for (let index = 0; index < records.length; index++) {
      const record = records[index]; if (!record) continue
      const status = record.slice(0,2), path = record.slice(3)
      const oldPath = /[RC]/.test(status) ? records[++index]! : null
      if (!validPath(path) || (oldPath !== null && !validPath(oldPath))) throw new Error("Git 路径不可安全表示，请在终端处理。")
      if (status.includes("U") || status === "AA" || status === "DD") blockedReason = "存在冲突文件，请先在终端解决。"
      files.push({path, oldPath, status, fingerprint: await fingerprint(root,path,budget)})
      if (files.length > MAX_FILES) throw new Error("变更文件超过 1000 项，请在终端处理。")
    }
    let upstream: GitRepository["upstream"] = null
    let remoteConfig = ""
    if (branch && head) {
      const remote = await optional(root, ["config", "--get", `branch.${branch}.remote`])
      const merge = await optional(root, ["config", "--get", `branch.${branch}.merge`])
      if (remote && /^[a-zA-Z0-9_.-]+$/.test(remote) && !remote.startsWith("-") && merge?.startsWith("refs/heads/")) {
        const counts = await optional(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        const urls = await optional(root, ["config", "--get-all", `remote.${remote}.pushurl`]) ?? await optional(root, ["config", "--get-all", `remote.${remote}.url`])
        remoteConfig = hash(JSON.stringify([urls, await optional(root,["config","--get-all",`remote.${remote}.push`])]))
        if (counts && urls && !urls.includes("\n")) {
          const [ahead,behind] = counts.split(/\s+/).map(Number)
          upstream = {remote,branch:merge.slice(11),ahead:ahead!,behind:behind!}
        }
      }
    }
    const indexPath = resolve(root, (await run(root,["rev-parse","--git-path","index"])).trim())
    const indexHash = await exists(indexPath) ? hash(await readFile(indexPath)) : "empty"
    return { branch, head, files, upstream, blockedReason, snapshot: hash(JSON.stringify({root,head,branch,indexHash,files,upstream,remoteConfig,blockedReason})) }
  }
  private async fresh(snapshot: string): Promise<GitRepository> {
    const state = await this.status()
    if (state.snapshot !== snapshot) throw new Error("文件、索引或分支已变化，请刷新后重新检查并勾选。")
    return state
  }
  /** 校验快照后生成有界统一 Diff，禁用外部 diff 与 textconv。 */
  async diff(snapshot: string, path: string): Promise<GitDiff> {
    const state = await this.fresh(snapshot), file = state.files.find(file => file.path === path)
    if (!file) throw new Error("文件不在当前变更集合中。")
    const root = await this.root()
    let text: string
    if (file.status === "??" || !state.head) {
      const result = await command(root,["diff","--no-ext-diff","--no-textconv","--no-color","--no-index","--", process.platform === "win32" ? "NUL" : "/dev/null",path])
      if (result.code > 1) throw new Error("该文件无法展示 Diff，请在终端查看。")
      text = result.out
    } else {
      text = await run(root,["diff","--no-ext-diff","--no-textconv","--no-color","HEAD","--",...(file.oldPath ? [file.oldPath] : []),path])
    }
    await this.fresh(snapshot)
    return {path,text:text.slice(0,DIFF_LIMIT) || "文件内容未改变（可能仅权限、二进制或元信息变化）。",truncated:text.length > DIFF_LIMIT}
  }
  /** 独立 index 提交勾选路径，成功后只推进真实 index 的对应条目。 */
  async commit(input: GitCommitInput): Promise<{sha: string; warning?: string}> {
    if (!input.message.trim() || input.message.length > 8192 || input.message.includes("\0")) throw new Error("请填写 1–8192 字符的提交说明。")
    if (!input.paths.length || input.paths.length > MAX_FILES || new Set(input.paths).size !== input.paths.length) throw new Error("请选择有效且不重复的文件。")
    const state = await this.fresh(input.snapshot)
    if (state.blockedReason) throw new Error(state.blockedReason)
    const paths: string[] = []
    for (const path of input.paths) {
      const file = state.files.find(file => file.path === path)
      if (!validPath(path) || !file) throw new Error("选择包含不属于当前变更的路径。")
      paths.push(...(file.oldPath ? [file.oldPath] : []),path)
    }
    const root = await this.root(), gitDir = (await run(root,["rev-parse","--absolute-git-dir"])).trim()
    const indexPath = resolve(root,(await run(root,["rev-parse","--git-path","index"])).trim()), lockPath = indexPath + ".lock"
    let lock: Awaited<ReturnType<typeof open>>
    try { lock = await open(lockPath,"wx",0o600) } catch { throw new Error("Git 索引正在被其他操作使用，请稍后刷新重试。") }
    let directory: string | null = null
    let sha: string | null = null
    let warning: string | undefined
    try {
      directory = await mkdtemp(join(gitDir,"hc190-index-"))
      const selectedIndex = join(directory,"selected"), mergedIndex = join(directory,"merged")
      await this.fresh(input.snapshot)
      if (state.head) await run(root,["read-tree",state.head],{index:selectedIndex})
      else await run(root,["read-tree","--empty"],{index:selectedIndex})
      // 独立 index 从 HEAD 开始，只加入已验证路径，不挪用用户未选的暂存内容。
      await run(root,["add","--all","--pathspec-from-file=-","--pathspec-file-nul"],{index:selectedIndex,input:[...new Set(paths)].join("\0")+"\0"})
      await this.fresh(input.snapshot)
      const changed = await command(root,["diff","--cached","--quiet","--no-ext-diff"],{index:selectedIndex})
      if (changed.code === 0) throw new Error("所选文件没有相对 HEAD 可提交的改动。")
      if (changed.code !== 1) throw new Error("无法核验所选文件，请在终端检查。")
      const tree = (await run(root,["write-tree"],{index:selectedIndex})).trim()
      const hooks = await guardedHooks(root,directory,tree)
      try { await run(root,["-c",`core.hooksPath=${hooks}`,"commit","--file=-"],{index:selectedIndex,input:input.message,timeout:60000}) }
      catch (error) {
        const after = await optional(root,["rev-parse","--verify","HEAD"])
        if (!after || after === state.head) throw error
        // HEAD 可能被其他进程或 hook 更新，只有父提交和审阅树都吻合才认领结果。
        const metadata = (await run(root,["show","--no-patch","--no-show-signature","--format=%T%x00%P",after])).trim().split("\0")
        if (metadata[0] !== tree || metadata[1] !== (state.head ?? "")) throw error
        sha = after
        warning = "提交已生成，但提交命令异常结束。请在终端检查后再推送，不要重复提交。"
      }
      sha ??= (await run(root,["rev-parse","HEAD"])).trim()
      // post-commit 也能移动 HEAD；成功退出仍须核验，避免把外部提交用于索引同步或自动推送。
      const metadata = (await run(root,["show","--no-patch","--no-show-signature","--format=%T%x00%P",sha])).trim().split("\0")
      if (metadata[0] !== tree || metadata[1] !== (state.head ?? "")) {
        throw new Error("提交后 HEAD 已变化，无法确认本次结果。请在终端检查提交记录与暂存区，不要重复提交。")
      }
      try {
        if (await exists(indexPath)) await copyFile(indexPath,mergedIndex)
        else await run(root,["read-tree","--empty"],{index:mergedIndex})
        // 只将选中路径在真实 index 中推进到新 HEAD，其余暂存条目逐项保留。
        await run(root,["reset","--quiet",sha,"--pathspec-from-file=-","--pathspec-file-nul"],{index:mergedIndex,input:[...new Set(paths)].join("\0")+"\0"})
        await lock.writeFile(await readFile(mergedIndex)); await lock.close(); await rename(lockPath,indexPath)
      } catch { return {sha,warning:"提交已成功，但索引同步未完成。请在终端检查暂存状态；不要重复提交。"} }
      return {sha,...(warning ? {warning} : {})}
    } finally {
      await lock.close().catch(()=>{}); await rm(lockPath,{force:true}); if (directory) await rm(directory,{recursive:true,force:true})
    }
  }
  /** 只推送已确认 HEAD 到当前 upstream，保留 hook/签名/认证且不 force。 */
  async push(input: {snapshot: string; head: string}): Promise<void> {
    const state = await this.fresh(input.snapshot)
    if (state.blockedReason) throw new Error(state.blockedReason)
    if (state.head !== input.head || !state.upstream) throw new Error("分支或 upstream 已变化，请刷新并在终端检查推送目标。")
    const root = await this.root()
    // 跟踪引用可能已过期；查询实际 push URL，避免误用不同的 fetch URL。
    const target = (await run(root,["remote","get-url","--push",state.upstream.remote])).trim()
    const remoteRef = `refs/heads/${state.upstream.branch}`
    const probe = await command(root,["ls-remote","--exit-code","--refs","--",target,remoteRef],{timeout:60000})
    if (probe.code !== 0) throw new Error("无法确认远端目标分支仍存在，请在终端检查；本次未执行推送。")
    // 网络探测期间可能发生外部写入；再次校验，并固定 SHA，避免推送稍后移动的 HEAD。
    await this.fresh(input.snapshot)
    // 显式 refspec 覆盖 push.default/remote.push，不使用 force，也不主动创建分支。
    await run(root,["push","--porcelain","--no-follow-tags","--",state.upstream.remote,`${input.head}:refs/heads/${state.upstream.branch}`],{timeout:60000})
  }
}
/** 创建绑定启动工作区的人工 Git port。 */
export function createWorkspaceGit(cwd: string): WorkspaceGit { return new LocalWorkspaceGit(cwd) }
