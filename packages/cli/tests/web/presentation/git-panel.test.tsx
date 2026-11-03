/** Git 变更面板：选择、全选、消息与提交结果的可观察行为。 */
/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { GitPanel } from "../../../src/web/presentation/context-dock/git-panel"
import { makeSnapshot, makeInteractive } from "./fixtures"
import { render, registerTestDom, setControlledValue } from "./render"
import type { WebIntent } from "../../../src/web/application/adapter"
const unregister = registerTestDom();afterAll(unregister)
function snapshot() { return makeSnapshot({interactive:makeInteractive({git:{busy:false,error:null,result:null,diff:null,repository:{snapshot:"snapshot",branch:"main",head:"head",upstream:{remote:"origin",branch:"main",ahead:2,behind:0},blockedReason:null,files:[{path:"a.ts",oldPath:null,status:" M",fingerprint:"1"},{path:"b.ts",oldPath:null,status:"??",fingerprint:"2"}]}}})}) }
test("默认不选文件，提供全选，非空信息后提交只包含所选项",()=>{
 const intents:WebIntent[]=[];const h=render(<GitPanel snapshot={snapshot()} dispatch={i=>intents.push(i)} disabled={false}/> )
 try {
 const commit=()=>Array.from(h.container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.classList.contains("button-primary"))!
 expect(commit().disabled).toBe(true)
 expect(commit().textContent).toBe("提交 0 个文件")
 const all=h.container.querySelector<HTMLInputElement>('[aria-label="全选变更文件"]')!;act(()=>all.click())
 expect(Array.from(h.container.querySelectorAll<HTMLInputElement>('[data-file-check]')).every(c=>c.checked)).toBe(true)
 const b=h.container.querySelector<HTMLInputElement>('[aria-label="选择 b.ts"]')!;act(()=>b.click())
 const message=h.container.querySelector<HTMLTextAreaElement>('textarea')!;act(()=>setControlledValue(message,"selected"))
 expect(commit().textContent).toBe("提交 1 个文件")
 expect(commit().disabled).toBe(false);act(()=>commit().click())
 expect(intents).toContainEqual({type:"git.commit",snapshot:"snapshot",paths:["a.ts"],message:"selected",push:false})
 expect(h.container.textContent).toContain("2 个未推送提交")
 }finally{h.unmount()}
})
test("文件查看发送快照与路径，忙碌时提交和输入禁用",()=>{
 const intents:WebIntent[]=[];const s=snapshot();const h=render(<GitPanel snapshot={s} dispatch={i=>intents.push(i)} disabled={false}/> )
 try {const file=h.container.querySelector<HTMLButtonElement>('[aria-label="查看 a.ts 的变更"]')!;act(()=>file.click());expect(intents).toContainEqual({type:"git.diff",snapshot:"snapshot",path:"a.ts"})}finally{h.unmount()}
 const busy=render(<GitPanel snapshot={{...s,interactive:{...s.interactive,git:{...s.interactive.git,busy:true}}}} dispatch={()=>{}} disabled={false}/> )
 try{expect(busy.container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true)}finally{busy.unmount()}
})
test("推送失败保留 SHA 并提供单独推送按钮",()=>{
 const intents:WebIntent[]=[];const s=snapshot();const h=render(<GitPanel snapshot={{...s,interactive:{...s.interactive,git:{...s.interactive.git,result:{sha:"new-sha",pushed:false,pushError:"denied"},repository:{...s.interactive.git.repository!,head:"new-sha"}}}}} dispatch={i=>intents.push(i)} disabled={false}/> )
 try{expect(h.container.textContent).toContain("new-sha");const retry=Array.from(h.container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.includes("重试推送"))!;act(()=>retry.click());expect(intents).toContainEqual({type:"git.push",snapshot:"snapshot",head:"new-sha"})}finally{h.unmount()}
})

test("同名文件显示名称并保留完整路径身份，Diff 标题区分文件与目录",()=>{
 const s=snapshot(),git=s.interactive.git
 const h=render(<GitPanel snapshot={{...s,interactive:{...s.interactive,git:{...git,repository:{...git.repository!,files:[
   {path:"src/index.ts",oldPath:null,status:" M",fingerprint:"1"},
   {path:"tests/index.ts",oldPath:null,status:" M",fingerprint:"2"},
 ]},diff:{path:"src/index.ts",text:"+hello",truncated:false}}}}} dispatch={()=>{}}/> )
 try {
  const names=Array.from(h.container.querySelectorAll(".git-file-path")).map(node=>node.textContent)
  expect(names).toEqual(["index.ts","index.ts"])
  expect(h.container.querySelector('[aria-label="查看 src/index.ts 的变更"]')?.getAttribute("title")).toBe("src/index.ts")
  expect(h.container.querySelector('[aria-label="查看 tests/index.ts 的变更"]')?.getAttribute("title")).toBe("tests/index.ts")
  expect(h.container.querySelector(".git-diff-title")?.textContent).toContain("index.ts")
  expect(h.container.querySelector(".git-diff-path")?.textContent).toBe("src/")
 }finally{h.unmount()}
})

test("Git Diff 按真实 hunk 展示行号与增删，保留原始元数据及非文本回退",()=>{
 const s=snapshot()
 const show=(text:string)=>render(<GitPanel snapshot={{...s,interactive:{...s.interactive,git:{...s.interactive.git,diff:{path:"a.ts",text,truncated:false}}}}} dispatch={()=>{}}/> )
 const h=show("diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n--- a/a.ts\n+++ b/a.ts\n@@ -4,2 +9,2 @@\n-old\n+<script>new</script>\n context\n")
 try {
  expect(Array.from(h.container.querySelectorAll(".git-line-number")).map(n=>n.textContent)).toEqual(["4","9","10"])
  expect(h.container.querySelector(".git-line-add")?.textContent).toContain("<script>new</script>")
  expect(h.container.querySelector("script")).toBeNull()
  expect(h.container.querySelector(".git-diff-raw")?.textContent).toContain("new mode 100755")
 }finally{h.unmount()}
 const binary=show("Binary files a/image.png and b/image.png differ")
 try {expect(binary.container.textContent).toContain("Binary files a/image.png and b/image.png differ")}finally{binary.unmount()}
})
