/** 正式 coordinator + 当前 ACP runtime + 真实 Java/HTTP MCP，连续轮次与最小失败生命周期证据。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { CollaborationClient, CollaborationState } from '@workbench/collaboration-client'
import { LocalAcpHost } from '@workbench/acp-runtime'
import { createLocalExecutionCoordinator } from '../../desktop/src/main/local-execution-coordinator.ts'
import { LocalConversationStore } from '../../desktop/src/main/local-conversation-store.ts'
import { WorkbenchContextService } from '../../desktop/src/main/workbench-context/service.ts'
import { ProjectMemoryStore, renderMemory } from '../../desktop/src/main/workbench-context/memory-store.ts'
const [origin,root]=process.argv.slice(2),ok=async p=>{const r=await p;assert.ok(r.ok,JSON.stringify(r));return r.value}
const admin=new CollaborationClient(origin),identity=new CollaborationState(origin)
const signed=await ok(admin.signIn('80278667'));await ok(identity.signIn('80278668'))
const ws=signed.workspaces[0].id,accountId=identity.personalIdentity().accountId,cwd=join(root,'context-cwd'),runRoot=await mkdtemp(join(root,'turn-run-')),report=join(runRoot,'actual-prompts.jsonl')
let seed
try{seed=JSON.parse(await readFile(join(root,'integration-seed.json'),'utf8'))}catch{}
if(!seed){
 await mkdir(cwd,{recursive:true});execFileSync('git',['init','-q',cwd]);execFileSync('git',['-C',cwd,'remote','add','origin','https://example.invalid/hc241/context.git'])
 const repository=await ok(admin.createRepository(ws,{name:'逐轮验证仓库',remoteUrl:'https://example.invalid/hc241/context.git',defaultBranch:'main',requestId:randomUUID()}))
 const meta={scope:{kind:'workspace',repositoryIds:[]},contentType:'article',category:'验证'}
 const rule=await ok(admin.createKnowledge(ws,{...meta,level:'rule',scope:{kind:'repositories',repositoryIds:[repository.repositoryId]},termKey:'turn-rule',title:'匹配仓库规约',text:'每轮必须完整遵守当前匹配仓库规约。',requestId:randomUUID()}))
 const experience=await ok(admin.createKnowledge(ws,{...meta,level:'experience',termKey:'turn-experience',title:'真实工具知识',text:'真实读取正文用于本轮提出有来源的工程事实。',requestId:randomUUID()}))
 seed={workspaceId:ws,rule,experience,repository,cwd};await writeFile(join(root,'integration-seed.json'),JSON.stringify(seed,null,2))
}
const {rule,experience}=seed,ruleRef=`knowledge:${rule.item.knowledgeId}:${rule.item.currentVersionId}`
const beforeReads=(await ok(admin.readKnowledgeFeedback(ws,experience.item.knowledgeId,experience.item.currentVersionId))).versionReadCount
const local=new LocalConversationStore(runRoot,origin),record=await ok(local.create(accountId,{workspaceId:ws,title:'正式逐轮接线',directoryPath:cwd}))
const scope={accountId,workspaceId:ws,projectId:null,conversationId:record.conversationId},memoryScope={origin,accountId,workspaceId:ws}
const notices=[],feedback=[],assembled=[]
const host=new LocalAcpHost({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/context-turn-acp-agent.mjs',import.meta.url)),report],env:{PATH:process.env.PATH}},{bindingDirectory:join(runRoot,'native'),bindingNamespace:origin,restorePolicy:'fallback-new'})
let bound,setup,firstKey
const context=new WorkbenchContextService({origin,identity,store:new ProjectMemoryStore(join(runRoot,'memory')),authorizeBinding:async s=>{const r=await local.getRecord(s.accountId,s.conversationId);return r?.workspaceId===s.workspaceId},onFeedback:f=>feedback.push(f)})
const coordinator=createLocalExecutionCoordinator({isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(_,n)=>notices.push(n)}},identity,null,{host:{bind:async(...args)=>{bound=await host.bind(...args);return bound},subscribeDiagnostics:f=>host.subscribeDiagnostics(f)}},{origin,grantsDir:join(runRoot,'grants'),localConversations:local,contextSession:{prepare:async(s,id)=>{setup=await context.prepareSession(s,id);return setup},release:(s,id)=>context.revokeSession(s,id)},contextAssembler:{
 assembleTurnContext:async input=>{const r=await context.assembleTurnContext(input),pair=await context.store.read(memoryScope);assembled.push({key:input.turnId,result:r,team:renderMemory('team.md',pair['team.md'].entries),personal:renderMemory('personal.md',pair['personal.md'].entries)});if(input.userText.includes('TWO'))await context.onTurnSettled({scope,turnId:firstKey,outcome:'completed'});if(input.userText.includes('REJECT'))await bound.close();return r},
 registerFixedKnowledge:(...args)=>context.registerFixedKnowledge(...args),confirmTurnDelivered:(...args)=>context.confirmTurnDelivered(...args),resetDeliveredContext:s=>context.resetDeliveredContext(s),onTurnSettled:input=>context.onTurnSettled(input),
}})
async function until(action,label){for(let i=0;i<150;i++){if(await action())return;await pause(50)}throw Error('等待'+label+'超时')}
const entries=async()=>Object.values(await context.store.read(memoryScope)).flatMap(d=>d.entries)
async function send(text,refs=[]){const key=randomUUID(),receipt=await ok(coordinator.send(scope,ready.bindingId,key,text,refs));assert.equal(receipt.status,'accepted',JSON.stringify(receipt));return{key,receipt}}
async function finish(run){await until(()=>notices.some(n=>n.kind==='finished'&&n.turnId===run.receipt.turnId),'正式终态');return notices.find(n=>n.kind==='finished'&&n.turnId===run.receipt.turnId)}
let ready
try{
 await coordinator.captureDirectorySelection()(cwd);ready=await ok(coordinator.prepare(scope,cwd));assert.equal(ready.available,true)
 const one=await send('HC241_CONTEXT_ONE');firstKey=one.key;assert.notEqual(firstKey,one.receipt.turnId)
 assert.equal((await finish(one)).failure,undefined)
 await until(async()=> (await entries()).some(e=>e.name==='跨轮验证工程'),'第一轮真实提案保存')
 assert.ok(feedback.some(f=>f.turnId===one.key&&f.toolId==='project-memory:memory-write'&&f.result.status==='saved'),'真实上下文键定位原ACP工具卡')
 const two=await send('HC241_CONTEXT_TWO',[ruleRef]);assert.equal((await finish(two)).failure,undefined)
 const prompts=(await readFile(report,'utf8')).trim().split('\n').map(JSON.parse)
 const firstText=prompts[0].prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n')
 const secondText=prompts[1].prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n')
 assert.ok(firstText.includes(assembled[0].team),'首轮送达完整team.md');assert.ok(firstText.includes(assembled[0].personal),'首轮送达完整personal.md')
 assert.ok(firstText.includes(rule.current.text),'首轮送达适用规约正文')
 assert.ok(!firstText.includes('团队知识标题（按需读取固定版本）'),'首轮不再附带标题目录')
 assert.ok(secondText.includes(assembled[1].team),'变更后次轮仅补发更新后的team.md')
 assert.ok(!secondText.includes('<本机记忆 personal.md'),'未变更的personal.md次轮不重复送达')
 assert.ok(secondText.includes(ruleRef))
 assert.equal(firstText.split(rule.current.text).length-1,1,'首轮规约只出现1次')
 assert.equal(secondText.split(rule.current.text).length-1,1,'手动同版不与自动规约重复')
 assert.ok(prompts[1].prompt.some(b=>b.type==='text'&&b.text.includes('跨轮验证工程')))
 await until(async()=> (await ok(admin.readKnowledgeFeedback(ws,experience.item.knowledgeId,experience.item.currentVersionId))).versionReadCount===beforeReads+1,'真实工具读取命中')
 assert.equal((await ok(admin.readKnowledgeFeedback(ws,rule.item.knowledgeId,rule.item.currentVersionId))).versionReadCount,0,'自动注入/手动引用不计工具命中')
 const failed=await send('HC241_CONTEXT_FAIL');assert.ok((await finish(failed)).failure)
 const cancelled=await send('HC241_CONTEXT_CANCEL')
 await until(()=>feedback.some(f=>f.turnId===cancelled.key&&f.result.status==='pending'),'取消前真实pending')
 await ok(coordinator.cancel(scope,ready.bindingId,cancelled.receipt.turnId));await finish(cancelled)
 await until(()=>feedback.some(f=>f.turnId===cancelled.key&&f.result.status==='cancelled'),'取消提案丢弃')
 assert.ok(!(await entries()).some(e=>['失败不得保存','取消不得保存'].includes(e.name)))
 const rejected=await ok(coordinator.send(scope,ready.bindingId,randomUUID(),'HC241_CONTEXT_REJECT',[]));assert.equal(rejected.status,'rejected')
 const server=setup.mcpServers.find(s=>s.name==='workbench-context'),response=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:'2.0',id:'after-reject',method:'tools/call',params:{name:'query_project_memory',arguments:{}}})})
 assert.ok((await response.json()).result.isError,'发送拒绝清理准备的活动轮')
 const beforeSolo=assembled.length,soloRecord=await ok(local.create(accountId,{workspaceId:null,title:'无团队不注入',directoryPath:cwd})),soloScope={...scope,workspaceId:null,conversationId:soloRecord.conversationId}
 const soloReady=await ok(coordinator.prepare(soloScope,cwd)),soloReceipt=await ok(coordinator.send(soloScope,soloReady.bindingId,randomUUID(),'HC241_CONTEXT_NONE',[]))
 assert.equal(soloReceipt.status,'accepted');await until(()=>notices.some(n=>n.kind==='finished'&&n.turnId===soloReceipt.turnId),'无团队普通消息完成')
 assert.equal(assembled.length,beforeSolo,'无团队不能调用装配器')
 const allPrompts=(await readFile(report,'utf8')).trim().split('\n').map(JSON.parse)
 assert.ok(!JSON.stringify(allPrompts.at(-1).prompt).includes('<本机记忆'))
 await writeFile(join(root,'context-turn-evidence.json'),JSON.stringify({result:'PASS',realJavaMySql:true,realCoordinatorRuntimeMcp:true,continuousTwoTurns:true,completeMdEachTurn:true,matchedRuleEachTurn:true,manualRuleDedup:true,actualKnowledgeRead:true,autoNotCounted:true,proposalSavedThenVisible:true,lateOldKeyIgnored:true,failureCancelledRejectedDiscard:true,noTeamNoInjection:true,sourceScope:scope,promptReport:report,first:{contextKey:one.key,acpTurnId:one.receipt.turnId},second:{contextKey:two.key,acpTurnId:two.receipt.turnId},modelGateway:false},null,2))
 console.log('PASS：正式协调器/真实runtime/HTTP MCP连续两轮完整材料、正常提案落盘下一轮可见、真实读取及去重、旧键保护、失败/取消/拒绝清理。')
}finally{await coordinator.dispose();await context.dispose();await host.close();identity.dispose()}
