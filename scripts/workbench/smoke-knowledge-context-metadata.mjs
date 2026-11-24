/** HC-241 接点必要冒烟：真实主进程解析/上下文/MCP，受控会话只核验元数据，不代替239逐轮送达。 */
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollaborationState } from '@workbench/collaboration-client'
import { WorkbenchContextService } from '../../desktop/src/main/workbench-context/service.ts'
import { ProjectMemoryStore } from '../../desktop/src/main/workbench-context/memory-store.ts'
import { LocalConversationStore } from '../../desktop/src/main/local-conversation-store.ts'
import { createLocalExecutionCoordinator } from '../../desktop/src/main/local-execution-coordinator.ts'
const accountId='11111111111111111111111111111111',workspaceId='11111111-1111-4111-8111-111111111111',knowledgeId='44444444-4444-4444-8444-444444444444',versionId='55555555-5555-4555-8555-555555555555'
const origin='http://127.0.0.1:9999',referenceId=`knowledge:${knowledgeId}:${versionId}`,text='固定正文第三版。',metadata={level:'rule',scope:{kind:'workspace',repositoryIds:[]},contentType:'article'},user={id:accountId,userNo:'80000001',userName:'冒烟用户',photo:'',orgId:'org',orgNo:'001',orgName:'研发',orgPathName:'研发'}
let reads=0,reports=0,unavailable=false
const json=body=>new Response(JSON.stringify({returnCode:'SUC0000',errorMsg:'',body}),{headers:{'content-type':'application/json'}})
const identity=new CollaborationState(origin,async input=>{const u=new URL(String(input)),p=u.pathname
 if(p.endsWith('/csrf'))return json({headerName:'X-CSRF-TOKEN',token:'smoke'})
 if(p.endsWith('/demo-login')||p.endsWith('/me'))return json({user,workspaces:[{id:workspaceId,slug:'smoke',name:'冒烟团队',role:'admin',memberVersion:1,accessVersion:1}]})
 if(p.endsWith('/projects'))return json({workspaceId,projects:[]})
 if(p.endsWith('/repositories'))return json({workspaceId,repositories:[]})
 if(p.endsWith('/knowledge')){if(unavailable)throw Error('受控规约读取失败');return json({items:[{knowledgeId,termKey:'rule',category:'约定',title:'固定规约',...metadata,currentVersionId:versionId,version:8,archived:false,updatedAtMs:1,health:{readCount:reports,usefulCount:0,expiredCount:0,needsReview:false,lastReviewedAtMs:1,feedbackWatermark:0}}],nextAfterId:null})}
 if(p.endsWith('/reads')){reports++;return json({recorded:true})}
 if(p.endsWith(`/versions/${versionId}`)){reads++;return json({knowledgeId,termKey:'rule',archived:false,version:{versionId,version:3,category:'约定',title:'固定规约',authorId:accountId,createdAtMs:1,...metadata,contributors:[accountId],reviewerId:null,reviewedAtMs:null,proposalId:null},text})}
 throw Error('未预期请求:'+p)
})
const root=await mkdtemp(join(tmpdir(),'hc241-metadata-')),cwd=join(root,'cwd');await mkdir(cwd)
const local=new LocalConversationStore(root,origin),notices=[],listeners=new Set(),prompts=[],assembled=[]
let context,coordinator,server,counter=0
const runtime={host:{bind:async()=>({getAvailability:()=>({available:true}),sendPrompt:(blocks,history)=>{prompts.push({blocks,history});return{status:'accepted',turnId:'acp-'+ ++counter}},send:()=>{throw Error('预期标准prompt')},subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},cancel:()=>true,close:async()=>listeners.clear()}),subscribeDiagnostics:()=>()=>{},close:async()=>{}}}
const rpc=async()=>{const r=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(server.headers.map(x=>[x.name,x.value]))},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_team_knowledge',arguments:{referenceId}}})});const b=await r.json();assert.ok(!b.result.isError,JSON.stringify(b));return JSON.parse(b.result.content[0].text)}
try{
 const signed=await identity.signIn('80000001');assert.ok(signed.ok,JSON.stringify(signed))
 const created=await local.create(accountId,{workspaceId,title:'固定材料元数据',directoryPath:cwd});assert.ok(created.ok)
 const scope={accountId,workspaceId,projectId:null,conversationId:created.value.conversationId}
 context=new WorkbenchContextService({origin,identity,store:new ProjectMemoryStore(join(root,'memory')),authorizeBinding:async()=>true})
 coordinator=createLocalExecutionCoordinator({isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(_,n)=>notices.push(n)}},identity,null,runtime,{origin,grantsDir:join(root,'grants'),localConversations:local,contextSession:{prepare:async(s,id)=>{const setup=await context.prepareSession(s,id);server=setup.mcpServers[0];return setup},release:(s,id)=>context.revokeSession(s,id)},contextAssembler:{assembleTurnContext:async input=>{const result=await context.assembleTurnContext(input);assembled.push({input,result});return result}}})
 await coordinator.captureDirectorySelection()(cwd)
 const ready=await coordinator.prepare(scope,cwd);assert.ok(ready.ok)
 const send=async(id,refs=[])=>{const result=await coordinator.send(scope,ready.value.bindingId,id,'普通用户原文',refs);assert.ok(result.ok&&result.value.status==='accepted',JSON.stringify(result));return result.value}
 const settle=async(id,turnId)=>{for(const f of listeners)f({type:'completed',turnId,sequence:1,shareable:true});await context.onTurnSettled({scope,turnId:id,outcome:'completed'})}
 const first=await send('manual',[referenceId])
 assert.equal(reads,1,'复用手动读取，不为自动规约再取一次正文')
 assert.deepEqual(assembled[0].input.fixedKnowledge,[{title:'固定规约',referenceId,version:3,text}],'固定正文版本3，而非列表CAS8')
 assert.equal(assembled[0].result.preparedKnowledge.length,0)
 assert.ok(!assembled[0].result.contextBlocks[0].text.includes(text),'自动组不再附同版正文')
 assert.ok(JSON.stringify(prompts[0].blocks).includes(text),'手动材料确实在当前prompt')
 assert.equal((await rpc()).alreadyRead,true);assert.equal(reports,0,'手动已提供不新增工具命中')
 assert.equal(notices.find(n=>n.kind==='accepted').text,'普通用户原文')
 await settle('manual',first.turnId)
 const second=await send('automatic')
 assert.equal(assembled[1].result.preparedKnowledge.length,1)
 assert.ok((await rpc()).text,'只准备的自动规约不能提前当作已读')
 assert.equal((await rpc()).alreadyRead,true)
 await settle('automatic',second.turnId)
 unavailable=true;context.knowledge.invalidate()
 const third=await send('degraded');assert.equal(third.knowledgeStatus.code,'unavailable')
 assert.match(third.knowledgeStatus.message,/可重试/)
 const accepted=notices.filter(n=>n.kind==='accepted').at(-1);assert.deepEqual(accepted.knowledgeStatus,third.knowledgeStatus);assert.equal(accepted.requestId,'degraded')
 assert.ok(!('preparedKnowledge' in accepted),'正文不进入受理通知')
 await settle('degraded',third.turnId)
 unavailable=false;context.knowledge.invalidate()
 const fourth=await send('ready-again');assert.equal(fourth.knowledgeStatus,undefined);assert.equal(notices.filter(n=>n.kind==='accepted').at(-1).knowledgeStatus,undefined)
 await settle('ready-again',fourth.turnId)
 console.log('PASS：真实手动固定版复用/同版规约去重；prepared不当已读；降级受理通知/回执和下轮清除。模块主动收口请求键，不宣称239轮次映射或逐轮正文送达。')
}finally{await coordinator?.dispose();await context?.dispose();identity.dispose();await rm(root,{recursive:true,force:true})}
