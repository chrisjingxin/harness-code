/** 正式 Electron 与隔离真实服务：正常 UI 新建会话、沉淀起草、编辑提交；复用既有后端与审核证据。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { CollaborationClient } from '../../packages/collaboration-client/dist/index.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'
const [origin,evidenceDirectory]=process.argv.slice(2),repo=fileURLToPath(new URL('../..',import.meta.url))
const require=createRequire(import.meta.url),profile=await mkdtemp(join(tmpdir(),'hc241-electron-'))
const child=spawn(require('electron'),['--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--inspect=0',join(repo,'desktop')],{env:{PATH:process.env.PATH,TMPDIR:tmpdir(),WORKBENCH_SERVICE_ORIGIN:origin,WORKBENCH_ACP_EXECUTABLE:process.execPath,WORKBENCH_ACP_ARGS_JSON:JSON.stringify([join(repo,"scripts/workbench/fixtures/knowledge-draft-acp-agent.mjs")])},stdio:['ignore','pipe','pipe']})
let logs='',main,ui
child.stdout.on('data',c=>{logs+=c});child.stderr.on('data',c=>{logs+=c})
async function until(action,label){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('桌面提前退出:'+logs.slice(-1200));const v=await action().catch(()=>null);if(v)return v;await pause(150)}throw Error('等待'+label+'超时')}
async function connect(url){const ws=new WebSocket(url);await once(ws,'open');let id=0;const pending=new Map();ws.onmessage=e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result)}};const send=(method,params)=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(Error('CDP超时'))},8000);pending.set(current,{resolve:v=>{clearTimeout(timer);resolve(v)},reject});ws.send(JSON.stringify({id:current,method,params}))});return {send,async evaluate(expression){const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value},close(){ws.close()}}}
async function click(text){return ui.evaluate(`(() => { const b=[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.disabled).at(-1); if(!b)throw Error('按钮不可用');b.click();return true })()`)}
async function text(){return ui.evaluate('document.body.innerText')}
let ws
const cwd=join(evidenceDirectory,'draft-cwd');await mkdir(cwd,{recursive:true})
const admin=new CollaborationClient(origin),signed=await admin.signIn('80278667');assert.ok(signed.ok);ws=signed.value.workspaces[0].id
const meta={level:'experience',scope:{kind:'workspace',repositoryIds:[]},contentType:'article'}
const existing=await admin.listKnowledge(ws,'回调',null);assert.ok(existing.ok);
const base=existing.value.items.find(x=>x.termKey==='callback-base')?{ok:true}:await admin.createKnowledge(ws,{termKey:'callback-base',category:'经验',title:'回调幂等经验',text:'回调可能重复投递，应避免重复记账。',...meta,requestId:randomUUID()});assert.ok(base.ok,JSON.stringify(base))
for(let i=0;i<3;i++){const list=await admin.listKnowledge(ws,'整组预算'+i,null);if(list.ok&&list.value.items.some(x=>x.termKey==='ui-budget-'+i))continue;const r=await admin.createKnowledge(ws,{termKey:'ui-budget-'+i,category:'约定',title:'整组预算'+i,text:'x'.repeat(3000),...meta,level:'rule',requestId:randomUUID()});assert.ok(r.ok,JSON.stringify(r))}
async function findClick(part){return ui.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&!e.disabled&&e.textContent.includes(${JSON.stringify(part)})).at(-1);if(!b)throw Error('找不到:'+${JSON.stringify(part)});b.click();return true})()`)}
async function fill(label,value){return ui.evaluate(`(()=>{const labels=[...document.querySelectorAll('dialog[open] label,.knowledge-review-detail label')];const l=labels.find(x=>x.textContent.trim().startsWith(${JSON.stringify(label)}));if(!l)throw Error('字段不可用');const e=l.querySelector('input,textarea'),p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)}
async function login(userNo){const r=await ui.evaluate(`window.collaboration.signIn(${JSON.stringify(userNo)})`);assert.ok(r.ok,JSON.stringify(r));await until(async()=>!(await text()).includes('正在恢复个人视图'),'身份界面')}
try{
 const mainUrl=await until(async()=>/Debugger listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1],'主进程')
 const browserUrl=await until(async()=>/DevTools listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1],'渲染进程')
 main=await connect(mainUrl);const page=await until(async()=>{const r=await fetch(new URL('/json/list',browserUrl.replace('ws:','http:')));return(await r.json()).find(p=>p.type==='page'&&p.url.startsWith('file:'))},'正式页面');ui=await connect(page.webSocketDebuggerUrl)
 await until(()=>ui.evaluate(`document.readyState==='complete'&&!!window.knowledgeDrafts&&!!document.querySelector('button')`),'正常入口')
 await login('80278668')
 const electron=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(repo,'desktop/package.json'))})('electron')`
 await main.evaluate(`(()=>{const e=${electron},original=e.dialog.showMessageBox;e.dialog.showMessageBox=async(...args)=>args.at(-1)?.buttons?.includes('确认目录')?{response:0,checkboxChecked:false}:original.apply(e.dialog,args);e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(cwd)}]});return true})()`)
 await until(()=>ui.evaluate(`!!document.querySelector('[aria-label="新会话准备"]')`),'正常新会话页')
 await writeFile(join(evidenceDirectory,'desktop-before.txt'),await text())
 await findClick('选择工作目录');await until(()=>findClick('选择本机文件夹'),'目录选择菜单')
 await until(()=>ui.evaluate(`!!document.querySelector('textarea')`),'新会话输入')
 await ui.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'退款回调重复投递导致重复记账，使用稳定业务幂等键和事务处理。');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
 await until(()=>ui.evaluate(`(()=>{const b=document.querySelector('button[aria-label="发送消息"]');if(!b||b.disabled)return false;b.click();return true})()`),'正常创建并发送')
 await until(async()=>/已确认：退款回调必须以业务幂等键/.test(await text()),'受控ACP正常一轮')
 const statusVisible=await until(async()=>/团队规约未附带：整组超过8 KiB/.test(await text()),'真实降级提示')
 const sourceState=await ui.evaluate(`window.collaboration.getState()`)
 const projectId='00000000-0000-4000-8000-0000000000a2'
 const listed=await ui.evaluate(`window.projectConversations.listConversations(${JSON.stringify(ws)},${JSON.stringify(projectId)})`);assert.ok(listed.ok,JSON.stringify(listed));const sourceRecord=listed.value.conversations.find(x=>x.ownerUserId===sourceState.value.user.id&&x.title.includes('退款回调重复投递'));assert.ok(sourceRecord,JSON.stringify(listed))
 await writeFile(join(evidenceDirectory,'desktop-source.txt'),await text())
 await until(()=>click('沉淀为团队知识'),'正式会话沉淀按钮')
 await until(async()=>{const ready=await ui.evaluate(`document.querySelectorAll('dialog[open] .knowledge-draft-turn input').length>0`);if(!ready)await click('重新读取定稿');return ready},'本人定稿轮次')
 // 显式选择真实显示的定稿，起草/候选/提议仅通过页面按钮，不调用宿主 start 或创建提议。
 await ui.evaluate(`(()=>{const e=document.querySelector('dialog[open] .knowledge-draft-turn input');if(e.checked)e.click();e.click();return e.checked})()`)
 await click('开始本机起草')
 await until(async()=>/AI 草稿已生成/.test(await text()),'真实UI起草候选')
 await until(()=>findClick('编辑候选：'),'编辑实际候选')
 const uiDraftTitle='退款回调经验（正常入口）-'+randomUUID().slice(0,6)
 await fill('标题',uiDraftTitle)
 await click('确认共享并提交审核')
 await until(()=>ui.evaluate(`document.querySelectorAll('dialog[open]').length===1`),'候选提交成功')
 const screenshot=await ui.send('Page.captureScreenshot',{format:'png'});await writeFile(join(evidenceDirectory,'desktop-review.png'),Buffer.from(screenshot.data,'base64'))
 const proposals=await ui.evaluate(`window.collaborationApps.listKnowledgeProposals(${JSON.stringify(ws)},'mine',null,null)`)
 assert.ok(proposals.ok,JSON.stringify(proposals));const submitted=proposals.value.items.find(x=>x.title===uiDraftTitle&&x.status==='submitted');assert.ok(submitted,JSON.stringify(proposals))
 const submittedDetail=await ui.evaluate(`window.collaborationApps.readKnowledgeProposal(${JSON.stringify(ws)},${JSON.stringify(submitted.proposalId)},null)`);assert.ok(submittedDetail.ok,JSON.stringify(submittedDetail));assert.equal(submittedDetail.value.proposal.content.sourceRefs[0].kind,'conversation');assert.equal(submittedDetail.value.proposal.content.sourceRefs[0].referenceId,sourceRecord.conversationId)
 await writeFile(join(evidenceDirectory,'desktop-evidence.json'),JSON.stringify({result:'PASS',entry:page.url,origin,workspaceId:ws,projectId,sourceConversationId:sourceRecord.conversationId,accountId:sourceState.value.user.id,normalUiNewProjectSession:true,realSourceTurn:true,controlledAgent:true,visibleDeveloperSourceDraft:true,developerSourceNavigationPending:false,humanEditSubmit:true,nonreadyStatusVisible:statusVisible,ordinaryMessageAccepted:true,scriptedDirectorySelection:true,modelGateway:false},null,2)+'\n')
 await rm(join(evidenceDirectory,'desktop-failure.txt'),{force:true})
 console.log('PASS：正常界面新建本人Project会话→受控ACP定稿→点击沉淀/选轮/起草→编辑提交；降级状态可见且消息受理')
}catch(error){if(ui)await writeFile(join(evidenceDirectory,'desktop-failure.txt'),String(error)+'\n'+await text().catch(()=>''));throw error}
finally{
 const electron=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(repo,'desktop/package.json'))})('electron')`
 await main?.evaluate(`(setTimeout(()=>${electron}.app.quit(),0),true)`).catch(()=>{});ui?.close();main?.close()
 if(child.exitCode===null){const ended=await Promise.race([once(child,'exit').then(()=>true),pause(3000).then(()=>false)]);if(!ended){child.kill('SIGTERM');await once(child,'exit')}}
 await rm(profile,{recursive:true,force:true})
}
