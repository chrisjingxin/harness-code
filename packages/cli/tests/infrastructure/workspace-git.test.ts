/** Git 写入仅在临时仓库/本地 bare remote 验证，绝不修改用户仓库。 */
import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceGit } from "../../src/infrastructure/workspace-git"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } })
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "hc190-git-")); roots.push(root)
  git(root, "init", "-q", "--initial-branch=main"); git(root,"config","user.name","Test"); git(root,"config","user.email","test@example.invalid"); git(root,"config","commit.gpgsign","false")
  await writeFile(join(root,"a.txt"),"a0\n"); await writeFile(join(root,"b.txt"),"b0\n")
  git(root,"add","."); git(root,"commit","-qm","initial")
  return { root, port: createWorkspaceGit(root) }
}
test("仅提交选中文件完整内容，未选文件的暂存区和工作区均保留", async () => {
  const {root,port}=await repo()
  await writeFile(join(root,"a.txt"),"a1\n"); git(root,"add","a.txt"); await writeFile(join(root,"a.txt"),"a2\n")
  await writeFile(join(root,"b.txt"),"b1\n"); git(root,"add","b.txt"); await writeFile(join(root,"b.txt"),"b2\n")
  const before=git(root,"show",":b.txt"), state=await port.status()
  const result=await port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"selected"})
  expect(result.sha).toBe(git(root,"rev-parse","HEAD").trim()); expect(git(root,"show","HEAD:a.txt")).toBe("a2\n")
  expect(git(root,"show","HEAD:b.txt")).toBe("b0\n"); expect(git(root,"show",":b.txt")).toBe(before)
  expect(await readFile(join(root,"b.txt"),"utf8")).toBe("b2\n"); expect(git(root,"diff","--cached","--name-only").trim()).toBe("b.txt")
},30_000)
test("特殊路径、新增、删除、rename 和子目录启动均按 Git 根提交", async () => {
  const {root}=await repo(); await mkdir(join(root,"sub")); const port=createWorkspaceGit(join(root,"sub"))
  const special="- 空格\n中文.txt"; await writeFile(join(root,special),"new\n"); git(root,"mv","a.txt","renamed.txt"); await rm(join(root,"b.txt"))
  const state=await port.status(); expect(state.files.find(f=>f.path==="renamed.txt")?.oldPath).toBe("a.txt")
  expect((await port.diff(state.snapshot,special)).text).toContain("+new")
  await port.commit({snapshot:state.snapshot,paths:state.files.map(f=>f.path),message:"paths\n\nbody"})
  expect(git(root,"ls-tree","--name-only","HEAD")).toContain("renamed.txt"); expect(git(root,"status","--porcelain")).toBe("")
},30_000)
test("内容、HEAD 或索引变化后拒绝旧快照；拒绝越界/pathspec/重复选择和空信息", async () => {
  const {root,port}=await repo(); await writeFile(join(root,"a.txt"),"changed\n"); const state=await port.status()
  for (const paths of [["../a.txt"],[":(glob)*"],["a.txt","a.txt"],[]]) await expect(port.commit({snapshot:state.snapshot,paths,message:"x"})).rejects.toThrow()
  await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"  "})).rejects.toThrow()
  await writeFile(join(root,"a.txt"),"newer\n"); await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow("刷新")
  const next=await port.status(); git(root,"add","b.txt"); git(root,"update-index","--assume-unchanged","b.txt")
  await expect(port.commit({snapshot:next.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow("刷新")
  expect(git(root,"rev-list","--count","HEAD").trim()).toBe("1")
},30_000)
test("hooks 失败保留原 HEAD/索引，且不跳过 hook", async () => {
  const {root,port}=await repo(); await writeFile(join(root,"a.txt"),"changed\n"); const head=git(root,"rev-parse","HEAD"), index=await readFile(join(root,".git/index"))
  const hook=join(root,".git/hooks/pre-commit"); await writeFile(hook,"#!/bin/sh\necho hook-blocked >&2\nexit 1\n"); await chmod(hook,0o755)
  const state=await port.status(); await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow("hook-blocked")
  expect(git(root,"rev-parse","HEAD")).toBe(head); expect(await readFile(join(root,".git/index"))).toEqual(index)
},30_000)
test("detached、进行中的操作与 submodule 阻止写入", async () => {
  const {root,port}=await repo(); await writeFile(join(root,"a.txt"),"changed\n")
  git(root,"checkout","--detach","-q"); expect((await port.status()).blockedReason).toContain("分支")
  git(root,"checkout","main","-q"); await writeFile(join(root,".git/MERGE_HEAD"),git(root,"rev-parse","HEAD")); expect((await port.status()).blockedReason).toContain("进行中")
  await rm(join(root,".git/MERGE_HEAD")); git(root,"update-index","--add","--cacheinfo",`160000,${git(root,"rev-parse","HEAD").trim()},submodule`)
  expect((await port.status()).blockedReason).toContain("子模块")
},30_000)
test("真实本地 upstream 推送；失败可仅重试 push，不重复提交", async () => {
  const {root,port}=await repo(); const remote=await mkdtemp(join(tmpdir(),"hc190-bare-")); roots.push(remote); git(remote,"init","--bare","-q")
  git(root,"remote","add","origin",remote); git(root,"push","-qu","origin","main")
  await writeFile(join(root,"a.txt"),"changed\n"); let state=await port.status(); expect(state.upstream).toMatchObject({remote:"origin",branch:"main",ahead:0})
  const result=await port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"push"}); state=await port.status(); expect(state.upstream?.ahead).toBe(1)
  const hook=join(remote,"hooks/pre-receive"); await writeFile(hook,"#!/bin/sh\nexit 1\n"); await chmod(hook,0o755)
  await expect(port.push({snapshot:state.snapshot,head:result.sha})).rejects.toThrow()
  await rm(hook); await port.push({snapshot:state.snapshot,head:result.sha})
  expect(git(remote,"rev-parse","refs/heads/main").trim()).toBe(result.sha); expect(git(root,"rev-list","--count","HEAD").trim()).toBe("2")
},30_000)
test("新仓库允许首次提交，非 Git 目录给出可处理错误", async () => {
  const root=await mkdtemp(join(tmpdir(),"hc190-new-")); roots.push(root); const port=createWorkspaceGit(root)
  await expect(port.status()).rejects.toThrow("Git")
  git(root,"init","-q","--initial-branch=main"); git(root,"config","user.name","Test"); git(root,"config","user.email","test@example.invalid"); git(root,"config","commit.gpgsign","false")
  await writeFile(join(root,"first.txt"),"hello\n"); const state=await port.status(); await port.commit({snapshot:state.snapshot,paths:["first.txt"],message:"first"}); expect(git(root,"status","--porcelain")).toBe("")
},30_000)

test("HEAD 变化和其他索引锁拒绝写入；缺失身份不创建提交",async()=>{
 const {root,port}=await repo();await writeFile(join(root,"a.txt"),"changed\n");let state=await port.status()
 git(root,"commit","--allow-empty","-qm","other");await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow("刷新")
 state=await port.status();await writeFile(join(root,".git/index.lock"),"other");await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow("索引");await rm(join(root,".git/index.lock"))
 git(root,"config","user.name","");git(root,"config","user.email","");state=await port.status();const before=git(root,"rev-parse","HEAD");await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow();expect(git(root,"rev-parse","HEAD")).toBe(before)
},30_000)
test("冲突状态明确阻止提交",async()=>{
 const {root,port}=await repo();git(root,"checkout","-qb","side");await writeFile(join(root,"a.txt"),"side\n");git(root,"commit","-qam","side");git(root,"checkout","-q","main");await writeFile(join(root,"a.txt"),"main\n");git(root,"commit","-qam","main");try{git(root,"merge","side")}catch{}
 expect((await port.status()).blockedReason).toBeTruthy()
},30_000)

test("hook 不能把未选文件夹带进提交；失败保留 HEAD 与原索引",async()=>{
 const {root,port}=await repo();await writeFile(join(root,"a.txt"),"a1\n");await writeFile(join(root,"b.txt"),"b1\n");const before=git(root,"rev-parse","HEAD"),index=await readFile(join(root,".git/index"))
 const hook=join(root,".git/hooks/pre-commit");await writeFile(hook,"#!/bin/sh\ngit add b.txt\n");await chmod(hook,0o755)
 const state=await port.status();await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"x"})).rejects.toThrow("hook")
 expect(git(root,"rev-parse","HEAD")).toBe(before);expect(await readFile(join(root,".git/index"))).toEqual(index)
},30_000)

test("upstream 在远端已被删除时拒绝推送，不重新创建目标分支", async () => {
  const {root,port}=await repo()
  const remote=await mkdtemp(join(tmpdir(),"hc190-deleted-remote-"));roots.push(remote)
  git(remote,"init","--bare","-q");git(root,"remote","add","origin",remote);git(root,"push","-qu","origin","main")
  await writeFile(join(root,"a.txt"),"new\n")
  let state=await port.status();const result=await port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"selected"})
  state=await port.status();git(remote,"update-ref","-d","refs/heads/main")
  await expect(port.push({snapshot:state.snapshot,head:result.sha})).rejects.toThrow("分支")
  expect(git(remote,"for-each-ref","--format=%(refname)","refs/heads/main")).toBe("")
},30_000)
test("提交前 hook 改写 HEAD 后失败时，不把其他提交报告为本次成功", async () => {
  const {root,port}=await repo()
  git(root,"commit","--allow-empty","-qm","external target")
  const target=git(root,"rev-parse","HEAD").trim()
  git(root,"update-ref","HEAD",git(root,"rev-parse","HEAD^").trim())
  await writeFile(join(root,"a.txt"),"selected\n")
  const hook=join(root,".git/hooks/pre-commit")
  await writeFile(hook,`#!/bin/sh\ngit update-ref HEAD ${target}\nexit 1\n`);await chmod(hook,0o755)
  const state=await port.status()
  await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"selected"})).rejects.toThrow()
  expect(git(root,"rev-parse","HEAD").trim()).toBe(target)
},30_000)


test("提交成功后 hook 移动 HEAD 时不认领外部提交，也不改写原索引", async () => {
  const {root,port}=await repo()
  git(root,"commit","--allow-empty","-qm","external target")
  const target=git(root,"rev-parse","HEAD").trim()
  git(root,"update-ref","HEAD",git(root,"rev-parse","HEAD^").trim())
  await writeFile(join(root,"a.txt"),"selected\n")
  await writeFile(join(root,"b.txt"),"unselected staged\n");git(root,"add","b.txt")
  const index=await readFile(join(root,".git/index"))
  const hook=join(root,".git/hooks/post-commit")
  await writeFile(hook,`#!/bin/sh\ngit update-ref HEAD ${target}\n`);await chmod(hook,0o755)
  const state=await port.status()
  await expect(port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"selected"})).rejects.toThrow("不要重复提交")
  expect(git(root,"rev-parse","HEAD").trim()).toBe(target)
  expect(await readFile(join(root,".git/index"))).toEqual(index)
},30_000)

test("探测推送目标期间 HEAD 改变时拒绝推送，保留远端原提交", async () => {
  const {root,port}=await repo()
  const remote=await mkdtemp(join(tmpdir(),"hc190-push-race-"));roots.push(remote)
  git(remote,"init","--bare","-q");git(root,"remote","add","origin",remote);git(root,"push","-qu","origin","main")
  const original=git(root,"rev-parse","HEAD").trim()
  await writeFile(join(root,"a.txt"),"selected\n")
  let state=await port.status();const result=await port.commit({snapshot:state.snapshot,paths:["a.txt"],message:"selected"})
  git(root,"commit","--allow-empty","-qm","external target")
  const target=git(root,"rev-parse","HEAD").trim();git(root,"update-ref","HEAD",result.sha)
  // 本地 Git ext helper 模拟远端探测期间的外部 HEAD 更新，无网络或用户仓库写入。
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
  const transport=join(remote,"transport")
  await writeFile(transport,`#!/bin/sh\nif [ "$GIT_EXT_SERVICE" = git-upload-pack ]; then\n  git -C ${quote(root)} update-ref refs/heads/main ${target}\n  exec git-upload-pack ${quote(remote)}\nfi\nexec git-receive-pack ${quote(remote)}\n`)
  await chmod(transport,0o755);git(root,"config","protocol.ext.allow","always");git(root,"config","remote.origin.pushurl",`ext::${transport}`)
  state=await port.status()
  await expect(port.push({snapshot:state.snapshot,head:result.sha})).rejects.toThrow("刷新")
  expect(git(root,"rev-parse","HEAD").trim()).toBe(target)
  expect(git(remote,"rev-parse","refs/heads/main").trim()).toBe(original)
},30_000)
