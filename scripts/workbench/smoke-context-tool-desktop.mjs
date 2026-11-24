/** 正式普通对话工具卡反馈：隔离Electron/本机记忆，正常团队入口/真实ACP工具/Java反馈；不重跑其他页面。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { CollaborationClient } from '../../packages/collaboration-client/dist/index.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'
const [origin,evidenceDirectory]=process.argv.slice(2),repo=fileURLToPath(new URL('../..',import.meta.url))
const require=createRequire(import.meta.url),profile=await mkdtemp(join(tmpdir(),'hc241-electron-'))
await mkdir(join(profile,'home'),{recursive:true})
const isolate=join(profile,'isolate.cjs')
await writeFile(isolate,`require('node:os').homedir=()=>${JSON.stringify(join(profile,'home'))};require('node:module').syncBuiltinESMExports();`)
const child=spawn(require('electron'),['--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--inspect=0',join(repo,'desktop')],{env:{PATH:process.env.PATH,NODE_OPTIONS:'--require='+isolate,TMPDIR:tmpdir(),WORKBENCH_SERVICE_ORIGIN:origin,WORKBENCH_ACP_EXECUTABLE:process.execPath,WORKBENCH_ACP_ARGS_JSON:JSON.stringify([join(repo,"scripts/workbench/fixtures/context-turn-acp-agent.mjs"),join(evidenceDirectory,"ui-actual-prompts.jsonl")])},stdio:['ignore','pipe','pipe']})
let logs='',main,ui
child.stdout.on('data',c=>{logs+=c});child.stderr.on('data',c=>{logs+=c})
async function until(action,label){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('桌面提前退出:'+logs.slice(-1200));const v=await action().catch(()=>null);if(v)return v;await pause(150)}throw Error('等待'+label+'超时')}
async function connect(url){const ws=new WebSocket(url);await once(ws,'open');let id=0;const pending=new Map();ws.onmessage=e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result)}};const send=(method,params)=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(Error('CDP超时'))},8000);pending.set(current,{resolve:v=>{clearTimeout(timer);resolve(v)},reject});ws.send(JSON.stringify({id:current,method,params}))});return {send,async evaluate(expression){const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value},close(){ws.close()}}}
async function click(text){return ui.evaluate(`(() => { const b=[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.disabled).at(-1); if(!b)throw Error('按钮不可用');b.click();return true })()`)}
async function text(){return ui.evaluate('document.body.innerText')}
const seed=JSON.parse(await readFile(join(evidenceDirectory,'integration-seed.json'),'utf8')),ws=seed.workspaceId
async function findClick(part){return ui.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&!e.disabled&&e.textContent.includes(${JSON.stringify(part)})).at(-1);if(!b)throw Error('找不到:'+${JSON.stringify(part)});b.click();return true})()`)}
try{
 const mainUrl=await until(async()=>/Debugger listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1],'主进程')
 main=await connect(mainUrl)
 const browserUrl=await until(async()=>/DevTools listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1],'渲染进程')
 const page=await until(async()=>{const r=await fetch(new URL('/json/list',browserUrl.replace('ws:','http:')));return(await r.json()).find(p=>p.type==='page'&&p.url.startsWith('file:'))},'正式页面');ui=await connect(page.webSocketDebuggerUrl)
 await until(()=>ui.evaluate(`!!window.collaboration&&!!document.querySelector('button')`),'正式入口')
 assert.ok((await ui.evaluate(`window.collaboration.signIn('80278668')`)).ok)
 const electron=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(repo,'desktop/package.json'))})('electron')`

 await main.evaluate(`(()=>{const e=${electron};e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(seed.cwd)}]});return true})()`)
 await until(()=>click('团队'),'切换团队空间')
 await until(()=>findClick('新建协作会话'),'正常新建协作会话')
 await until(()=>ui.evaluate(`!!document.querySelector('[aria-label="新会话准备"]')`),'团队新会话页')
 await findClick('选择工作目录');await until(()=>findClick('选择本机文件夹'),'原生目录选择')
 await ui.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'HC241_CONTEXT_ONE 普通工具卡反馈验证');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
 await until(()=>ui.evaluate(`(()=>{const b=document.querySelector('button[aria-label="发送消息"]');if(!b||b.disabled)return false;b.click();return true})()`),'正常发送')
 await until(async()=>/正式逐轮上下文验证完成/.test(await text()),'真实工具轮完成')
 await until(()=>findClick('read_team_knowledge'),'展开正式知识工具卡')
 await until(()=>ui.evaluate(`!!document.querySelector('[aria-label="知识版本反馈"]')`),'固定版本芯片及轻反馈')
 const before=await ui.evaluate(`window.collaborationApps.readKnowledgeFeedback(${JSON.stringify(ws)},${JSON.stringify(seed.experience.item.knowledgeId)},${JSON.stringify(seed.experience.item.currentVersionId)})`);assert.ok(before.ok,JSON.stringify(before))
 await click('有用')
 await until(()=>ui.evaluate(`document.querySelector('[aria-label="知识版本反馈"] button[aria-pressed="true"]')?.textContent==='有用'`),'工具卡真实反馈')
 const actual=await ui.evaluate(`window.collaborationApps.readKnowledgeFeedback(${JSON.stringify(ws)},${JSON.stringify(seed.experience.item.knowledgeId)},${JSON.stringify(seed.experience.item.currentVersionId)})`);assert.ok(actual.ok);assert.equal(actual.value.value,'useful')
 assert.equal(actual.value.versionReadCount,before.value.versionReadCount,'人的反馈不新增Agent命中')
 const screenshot=await ui.send('Page.captureScreenshot',{format:'png'});await writeFile(join(evidenceDirectory,'ordinary-tool-feedback.png'),Buffer.from(screenshot.data,'base64'))
 await writeFile(join(evidenceDirectory,'ordinary-tool-feedback.json'),JSON.stringify({result:'PASS',origin,normalTeamUi:true,realControlledAcp:true,actualKnowledgeTool:true,fixedVersionChip:true,toolCardUsefulPersisted:true,noReadFromHumanFeedback:true,isolatedHome:true,modelGateway:false},null,2))
 await rm(join(evidenceDirectory,'ordinary-tool-failure.txt'),{force:true})
 console.log('PASS：正式正常团队会话入口→普通知识工具卡→固定版芯片→有用反馈持久化，非起草专用会话。')
}catch(error){if(ui)await writeFile(join(evidenceDirectory,'ordinary-tool-failure.txt'),String(error)+'\n'+await text().catch(()=>''));throw error}
finally{
 const electron=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(repo,'desktop/package.json'))})('electron')`
 await main?.evaluate(`(setTimeout(()=>${electron}.app.quit(),0),true)`).catch(()=>{});ui?.close();main?.close()
 if(child.exitCode===null){const ended=await Promise.race([once(child,'exit').then(()=>true),pause(3000).then(()=>false)]);if(!ended){child.kill('SIGTERM');await once(child,'exit')}}
 await rm(profile,{recursive:true,force:true})
}
