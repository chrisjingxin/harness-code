/** 人工 Git 与 Agent 共用 Controller 的并发、失败和可观察状态。 */
import { expect, test } from "bun:test"
import type { WorkspaceGit, GitRepository } from "../../src/interactive/ports/workspace-git"
import { makeHarness } from "./harness"
const repository: GitRepository = {snapshot:"snapshot",branch:"main",head:"old",files:[{path:"a.txt",oldPath:null,status:" M",fingerprint:"f"}],upstream:{remote:"origin",branch:"main",ahead:0,behind:0},blockedReason:null}
function port(): WorkspaceGit { return { status:async()=>repository, diff:async()=>({path:"a.txt",text:"diff",truncated:false}),commit:async()=>({sha:"new"}),push:async()=>{} } }
test("Git 写入在共享 Core 加锁，阻止重复写入、提交 Prompt 与切 Thread", async()=>{
  let release!:()=>void; let commits=0; const git=port(); git.commit=async()=>{commits++;await new Promise<void>(r=>release=r);return {sha:"new"}}
  const h=makeHarness({workspaceGit:git}); await h.controller.dispatch({type:"git.refresh"})
  const pending=h.controller.dispatch({type:"git.commit",snapshot:"snapshot",paths:["a.txt"],message:"x",push:false})
  expect(h.controller.getSnapshot().git.busy).toBe(true)
  for(const intent of [{type:"input.submit",value:"hello"},{type:"thread.open",threadId:"t2"},{type:"git.commit",snapshot:"snapshot",paths:["a.txt"],message:"x",push:false}] as const) expect((await h.controller.dispatch(intent)).status).toBe("rejected")
  release(); await pending; expect(commits).toBe(1); expect(h.controller.getSnapshot().git.result?.sha).toBe("new"); await h.controller.close()
})
test("commit 成功而 push 失败保留 SHA，单独重试不再次 commit",async()=>{
  const git=port();let commits=0,pushes=0;git.commit=async()=>{commits++;return {sha:"new"}};git.status=async()=>({...repository,head:commits?"new":"old"});git.push=async()=>{if(++pushes===1)throw new Error("push rejected")}
  const h=makeHarness({workspaceGit:git});await h.controller.dispatch({type:"git.refresh"}); await h.controller.dispatch({type:"git.commit",snapshot:"snapshot",paths:["a.txt"],message:"x",push:true})
  expect(h.controller.getSnapshot().git.result).toMatchObject({sha:"new",pushed:false,pushError:"push rejected"})
  await h.controller.dispatch({type:"git.push",snapshot:"snapshot",head:"new"});expect(commits).toBe(1);expect(pushes).toBe(2);expect(h.controller.getSnapshot().git.result?.pushed).toBe(true);await h.controller.close()
})
test("Agent 运行中拒绝 Git 写入",async()=>{
  const h=makeHarness({workspaceGit:port()});await h.controller.dispatch({type:"input.submit",value:"work"})
  expect(await h.controller.dispatch({type:"git.commit",snapshot:"snapshot",paths:["a.txt"],message:"x",push:false})).toMatchObject({status:"rejected",code:"busy"});await h.controller.close()
})

test("审批、Compose、Goal 与压缩状态都锁定人工 Git 写入",async()=>{
 const {gitWriteBlockedReason}=await import("../../src/interactive/features/workspace-git")
 const h=makeHarness({workspaceGit:port()}),base=h.controller.getSnapshot()
 expect(gitWriteBlockedReason({...base,confirmation:{confirmationId:"x",title:"x",message:"x"}})).toBeTruthy()
 expect(gitWriteBlockedReason({...base,activity:{kind:"compacting"}})).toBeTruthy()
 expect(gitWriteBlockedReason({...base,composeState:{threadId:"t",slug:"x",complexity:"simple",status:"active",currentStage:"grill",waiting:"none",stages:[],documents:[],fixRounds:0,revision:1}})).toBeTruthy()
 expect(gitWriteBlockedReason({...base,goal:{goal_id:"g",revision:1,status:"active",objective:"x",assumptions:[],criteria:[],note:null,prior_blocker:null,grader:{},max_iterations:1,created_at_ms:0,updated_at_ms:0,completed_at_ms:null}})).toBeTruthy()
 await h.controller.close()
})

test("提交有异常警告时保留 SHA，但不自动推送",async()=>{
  let pushes=0;const git=port();git.commit=async()=>({sha:"new",warning:"检查提交结果"});git.push=async()=>{pushes++}
  const h=makeHarness({workspaceGit:git});await h.controller.dispatch({type:"git.refresh"})
  await h.controller.dispatch({type:"git.commit",snapshot:"snapshot",paths:["a.txt"],message:"x",push:true})
  expect(h.controller.getSnapshot().git.result).toMatchObject({sha:"new",pushed:false,warning:"检查提交结果"});expect(pushes).toBe(0);await h.controller.close()
})

test("启动恢复会话尚未完成时拒绝 Git 写入",async()=>{
  let release!:()=>void,commits=0;const git=port();git.commit=async()=>{commits++;return {sha:"new"}}
  const h=makeHarness({workspaceGit:git,initialThreadId:"restoring",openThreadImpl:async()=>{await new Promise<void>(resolve=>release=resolve);throw new Error("test completed")}})
  const result=await h.controller.dispatch({type:"git.commit",snapshot:"snapshot",paths:["a.txt"],message:"x",push:false})
  try{expect(result).toMatchObject({status:"rejected",code:"busy"});expect(commits).toBe(0)}finally{await h.controller.close();release()}
})
