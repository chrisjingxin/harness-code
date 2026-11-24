/** 正式 Electron + 隔离真实服务：只通过页面操作角色与交接；不注入夹具或伪造网络。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { CollaborationClient } from '../../packages/collaboration-client/dist/index.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'
const [origin,evidenceDirectory]=process.argv.slice(2),repo=fileURLToPath(new URL('../..',import.meta.url))
const require=createRequire(import.meta.url),profile=await mkdtemp(join(tmpdir(),'hc240-electron-'))
const child=spawn(require('electron'),['--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--inspect=0',join(repo,'desktop')],{env:{PATH:process.env.PATH,TMPDIR:tmpdir(),WORKBENCH_SERVICE_ORIGIN:origin},stdio:['ignore','pipe','pipe']})
let logs='',main,ui
child.stdout.on('data',c=>{logs+=c});child.stderr.on('data',c=>{logs+=c})
async function until(action,label){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('桌面提前退出:'+logs.slice(-1200));const v=await action().catch(()=>null);if(v)return v;await pause(150)}throw Error('等待'+label+'超时')}
async function connect(url){const ws=new WebSocket(url);await once(ws,'open');let id=0;const pending=new Map();ws.onmessage=e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result)}};const send=(method,params)=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(Error('CDP超时'))},8000);pending.set(current,{resolve:v=>{clearTimeout(timer);resolve(v)},reject});ws.send(JSON.stringify({id:current,method,params}))});return {send,async evaluate(expression){const v=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value},close(){ws.close()}}}
async function click(text){return ui.evaluate(`(() => { const b=[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.disabled).at(-1); if(!b)throw Error('按钮不可用');b.click();return true })()`)}
async function select(label,value){await until(()=>ui.evaluate(`(() => { const e=document.querySelector('select[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');return e && !e.disabled && [...e.options].some(o=>o.value===${JSON.stringify(value)})})()`),label+"可选");return ui.evaluate(`(() => { const e=document.querySelector('select[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');if(!e)throw Error('下拉框不可用');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)}
async function text(){return ui.evaluate('document.body.innerText')}
async function openSettings(){await ui.evaluate(`document.querySelector('button[aria-label="设置"]').click()`);await until(async()=>/团队设置 ·/.test(await text()),'团队设置')}
try{
 const mainUrl=await until(async()=>/Debugger listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1],'主进程')
 const browserUrl=await until(async()=>/DevTools listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1],'渲染进程')
 main=await connect(mainUrl)
 const page=await until(async()=>{const r=await fetch(new URL('/json/list',browserUrl.replace('ws:','http:')));return (await r.json()).find(p=>p.type==='page'&&p.url.startsWith('file:'))},'正式页面')
 ui=await connect(page.webSocketDebuggerUrl)
 await until(()=>ui.evaluate(`document.readyState==='complete' && !!document.querySelector('button')`),'页面入口')
 await until(()=>click('演示登录'),'登录入口');await until(()=>ui.evaluate(`!!document.querySelector('select[aria-label="演示账号"]')`),'账号选择')
 await select('演示账号','80278667');await click('演示登录')
 await until(()=>ui.evaluate(`!!document.querySelector('button[aria-label="设置"]') && !document.querySelector('select[aria-label="演示账号"]') && document.body.innerText.includes('沈北辰')`),'管理员已登录')
 await openSettings();await until(()=>ui.evaluate(`!!document.querySelector('select[aria-label="王大林的团队角色"]')`),'真实成员表')
 await select('王大林的团队角色','admin')
 await until(async()=>await ui.evaluate(`document.querySelector('select[aria-label="王大林的团队角色"]')?.value==='admin'`),'提升管理员')
 // 等待服务刷新完成后再降级，避免把尚未提交的选择当成成功。
 await until(()=>ui.evaluate(`document.querySelector('select[aria-label="王大林的团队角色"]')?.disabled===false && !document.querySelector('.team-settings [role="alert"]')`),'角色提交完成')
 await pause(250)
 await select('王大林的团队角色','developer')
 await until(()=>ui.evaluate(`document.querySelector('select[aria-label="王大林的团队角色"]')?.value==='developer' && document.querySelector('select[aria-label="沈北辰的团队角色"]')?.disabled===true`),'恢复开发者和最后管理员保护')
 await until(()=>ui.evaluate(`document.querySelector('select[aria-label="王大林的团队角色"]')?.disabled===false`),'角色刷新完成')
 await ui.evaluate(`(() => { const row=[...document.querySelectorAll('.team-settings-table tbody tr')].find(e=>e.textContent.includes('杨康'));const b=[...row.querySelectorAll('button')].find(e=>e.textContent.includes('移除与交接'));if(b.disabled)throw Error('移除不可用');b.click() })()`)
 await until(async()=>/正式界面交接任务/.test(await text()),'真实交接清单')
 await select('默认接手人','000000000000400080000000000000d3')
 await ui.evaluate(`(() => {const e=[...document.querySelectorAll('dialog .team-confirm input')].find(e=>e.parentElement.textContent.includes('我已核对交接清单'));e.click()})()`)
 const shot=await ui.send('Page.captureScreenshot',{format:'png'});await writeFile(join(evidenceDirectory,'desktop-handoff.png'),Buffer.from(shot.data,'base64'))
 await click('确认交接并移除')
 await until(()=>ui.evaluate(`!document.querySelector('.team-removal-dialog') && [...document.querySelectorAll('.team-settings-table tbody tr')].some(e=>e.textContent.includes('杨康')&&e.textContent.includes('原成员已离开'))`),'正式界面交接成功')
 const state=await ui.evaluate('window.collaboration.getState()');assert.equal(state.value.status,'signedIn');assert.equal(state.value.workspaces[0].role,'admin')
 // 使用页面登录开发者，确认管理入口真实收回。
 await click('退出 / 切换账号')
 await until(()=>ui.evaluate(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='演示登录')`),'退出完成')
 await until(()=>click('演示登录'),'登录入口');await until(()=>ui.evaluate(`!!document.querySelector('select[aria-label="演示账号"]')`),'开发者账号选择')
 await select('演示账号','80278669');await click('演示登录')
 await until(()=>ui.evaluate(`!!document.querySelector('button[aria-label="设置"]') && !document.querySelector('select[aria-label="演示账号"]') && document.body.innerText.includes('王大林')`),'开发者登录')
 await openSettings();await until(async()=>/团队知识由管理员发布/.test(await text()),'开发者权限提示')
 assert.equal(await ui.evaluate(`document.querySelectorAll('.team-settings button').length>0 && [...document.querySelectorAll('.team-settings button')].some(b=>b.textContent.includes('移除与交接'))`),false)
 const administrator=new CollaborationClient(origin)
 const adminLogin=await administrator.signIn('80278667');assert.equal(adminLogin.ok,true)
 const w=adminLogin.value.workspaces[0].id, targetUser='000000000000400080000000000000d3'
 async function realRole(role){const rows=await administrator.listMembers(w);assert.equal(rows.ok,true);const m=rows.value.members.find(m=>m.user.id===targetUser);const result=await administrator.changeWorkspaceRole(w,targetUser,{role,expectedVersion:m.version,requestId:randomUUID()});assert.equal(result.ok,true,JSON.stringify(result))}
 await realRole('admin')
 await until(()=>ui.evaluate(`!!document.querySelector('select[aria-label="沈北辰的团队角色"]')`),'已打开开发者窗口获得管理入口')
 await realRole('developer')
 await until(()=>ui.evaluate(`!document.querySelector('select[aria-label="沈北辰的团队角色"]') && document.body.innerText.includes('团队知识由管理员发布')`),'旧页面权限实时收回')
 const rejected=await ui.evaluate(`window.collaborationApps.createKnowledge(${JSON.stringify(w)},{level:'experience',scope:{kind:'workspace',repositoryIds:[]},contentType:'article',requestId:crypto.randomUUID(),termKey:'forbidden-ui',category:'经验',title:'不可发布',text:'不可发布'})`)
 assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'WORKSPACE_ADMIN_REQUIRED')
 administrator.dispose()
 const api=JSON.parse(await readFile(join(evidenceDirectory,'api-evidence.json'),'utf8'))
 const task=await ui.evaluate(`window.collaborationApps.readTask(${JSON.stringify(api.workspace)},'00000000-0000-4000-8000-0000000000a1',${JSON.stringify(api.uiTaskId)})`)
 assert.equal(task.ok,true,JSON.stringify(task));assert.equal(task.value.task.assigneeId,api.uiSuccessor)
 await writeFile(join(evidenceDirectory,'desktop-evidence.json'),JSON.stringify({result:'PASS',entry:page.url,realService:origin,roleChange:true,lastAdminDisabled:true,uiHandoff:true,historyDepartureLabel:true,developerManagementHidden:true,liveRoleRevocation:true,oldWindowPublishDenied:true,realTaskAssignee:task.value.task.assigneeId},null,2)+'\n')
 console.log('PASS：正式 Electron 使用真实服务完成角色变更、交接和开发者权限展示')
}catch(error){if(ui)await writeFile(join(evidenceDirectory,'desktop-failure.txt'),String(error)+'\n'+await text().catch(()=>''));throw error}
finally{
 const electron=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(repo,'desktop/package.json'))})('electron')`
 await main?.evaluate(`(setTimeout(()=>${electron}.app.quit(),0),true)`).catch(()=>{})
 ui?.close();main?.close()
 if(child.exitCode===null){const ended=await Promise.race([once(child,'exit').then(()=>true),pause(3000).then(()=>false)]);if(!ended){child.kill('SIGTERM');await once(child,'exit')}}
 await rm(profile,{recursive:true,force:true})
}
