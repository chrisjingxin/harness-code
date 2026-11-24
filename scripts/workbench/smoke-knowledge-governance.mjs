/** 隔离真实 Java/MySQL + 本机 ACP/HTTP MCP 主路径；受控 Agent 无模型密钥。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { CollaborationClient,CollaborationState } from '@workbench/collaboration-client'
import { LocalAcpHost } from '@workbench/acp-runtime'
import { WorkbenchContextService } from '../../desktop/src/main/workbench-context/service.ts'
import { ProjectMemoryStore } from '../../desktop/src/main/workbench-context/memory-store.ts'
import { LocalConversationStore } from '../../desktop/src/main/local-conversation-store.ts'
import { createLocalExecutionCoordinator } from '../../desktop/src/main/local-execution-coordinator.ts'
import { KnowledgeDraftService } from '../../desktop/src/main/knowledge-drafts/service.ts'
const [origin,root]=process.argv.slice(2)
const ok=async p=>{const r=await p;assert.ok(r.ok,JSON.stringify(r));return r.value}
const fails=async(p,code)=>{const r=await p;assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.error.code,code)}
const admin=new CollaborationClient(origin),reader=new CollaborationClient(origin),developer=new CollaborationState(origin)
const a=await ok(admin.signIn('80278667')),b=await ok(reader.signIn('80278669'));await ok(developer.signIn('80278668'))
const ws=a.workspaces[0].id,account=developer.personalIdentity().accountId,dev=developer.network()
const meta={level:'experience',scope:{kind:'workspace',repositoryIds:[]},contentType:'article'}
const base=await ok(admin.createKnowledge(ws,{termKey:'callback-base',category:'经验',title:'回调幂等经验',text:'回调可能重复投递，应避免重复记账。',...meta,requestId:randomUUID()}))
await fails(dev.createKnowledge(ws,{termKey:'not-allowed',category:'经验',title:'不应发布',text:'拒绝',...meta,requestId:randomUUID()}),'WORKSPACE_ADMIN_REQUIRED')
const cwd=join(root,'draft-cwd');await mkdir(cwd)
const local=new LocalConversationStore(root,origin),record=await ok(local.create(account,{workspaceId:ws,title:'退款幂等本机验证',directoryPath:cwd,providerId:'controlled'}))
const sourceTurn=randomUUID();await ok(local.appendTurn(account,record.conversationId,{turnId:sourceTurn,userText:'退款回调重试导致重复记账，应该怎样处理？',reply:'采用稳定业务幂等键，并用事务校验已处理状态。',status:'completed',acceptedAtMs:Date.now(),completedAtMs:Date.now()}))
const scope={accountId:account,workspaceId:ws,projectId:null,conversationId:record.conversationId}
const runtime={host:new LocalAcpHost({executable:process.execPath,args:[fileURLToPath(new URL('./fixtures/knowledge-draft-acp-agent.mjs',import.meta.url))],env:{PATH:process.env.PATH}},{enableClientFs:false,enableElicitation:true,restorePolicy:'fallback-new'})}
const context=new WorkbenchContextService({origin,identity:developer,store:new ProjectMemoryStore(join(root,'memory')),authorizeBinding:async s=>{const r=await local.getRecord(s.accountId,s.conversationId);return r?.workspaceId===s.workspaceId&&r?.projectId===s.projectId}})
const notices=[],window={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,send:(_channel,n)=>notices.push(n)}}
let formalSetup
const coordinator=createLocalExecutionCoordinator(window,developer,null,runtime,{origin,grantsDir:join(root,'grants'),localConversations:local,contextSession:{prepare:async(s,id)=>{formalSetup=await context.prepareSession(s,id);return formalSetup},release:(s,id)=>context.revokeSession(s,id)}})
const states=[];const drafting=new KnowledgeDraftService(developer,local,runtime,context,(s,path,p)=>coordinator.prepare(s,path,p),s=>states.push(s),null)
try{
 await coordinator.captureDirectorySelection()(cwd)
 const before=(await ok(reader.listKnowledge(ws,'',null))).items.find(x=>x.knowledgeId===base.item.knowledgeId).health.readCount
 const run=await drafting.start(scope,{kind:'conversation',turnIds:[sourceTurn]});let final
 for(let i=0;i<150;i++){final=drafting.read(run.executionId);if(['completed','failed','cancelled'].includes(final.status))break;await pause(100)}
 const server=formalSetup.mcpServers.find(s=>s.name==='workbench-context')
 const formalResponse=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})
 assert.equal(formalResponse.status,200);assert.equal((await formalResponse.json()).result.tools.length,4)
 assert.equal(final.status,'completed',JSON.stringify(final));assert.equal(final.candidates.length,1);assert.equal(final.searches.length,1);assert.equal(final.readReferences.length,1)
 const candidate=final.candidates[0];assert.equal(candidate.generationKind,'agent');assert.equal(candidate.sourceRefs[0].referenceId,scope.conversationId)
 for(let i=0;i<40;i++){if((await ok(reader.readKnowledge(ws,base.item.knowledgeId))).item.health.readCount===before+1)break;await pause(100)}
 assert.equal((await ok(reader.readKnowledge(ws,base.item.knowledgeId))).item.health.readCount,before+1)
 const req={content:candidate,submit:false,requestId:randomUUID()};let proposed=await ok(dev.createKnowledgeProposal(ws,req));assert.equal((await ok(dev.createKnowledgeProposal(ws,req))).proposal.proposalId,proposed.proposal.proposalId)
 const pid=proposed.proposal.proposalId
 await fails(reader.readKnowledgeProposal(ws,pid,null),'RESOURCE_NOT_FOUND');await fails(admin.readKnowledgeProposal(ws,pid,null),'RESOURCE_NOT_FOUND')
 assert.equal((await ok(reader.readKnowledge(ws,base.item.knowledgeId))).current.text,base.current.text)
 const action=(p)=>({expectedRevision:p.proposal.revision,confirmShare:true,requestId:randomUUID()})
 proposed=await ok(dev.submitKnowledgeProposal(ws,pid,action(proposed)))
 await fails(reader.readKnowledgeProposal(ws,pid,null),'WORKSPACE_ADMIN_REQUIRED')
 const review=(p,decision,note='',finalCandidate=null)=>({decision,expectedRevision:p.proposal.revision,requestId:randomUUID(),baseVersionId:p.proposal.content.baseVersionId,expectedItemVersion:p.proposal.content.baseItemVersion,finalCandidate,note})
 proposed=await ok(admin.reviewKnowledgeProposal(ws,pid,review(proposed,'return','请补上事务边界。')));assert.equal(proposed.proposal.lastReason,'请补上事务边界。')
 candidate.candidate.text+='\n本人补充：幂等记录与业务写入使用同一数据库事务。'
 proposed=await ok(dev.editKnowledgeProposal(ws,pid,{content:candidate,expectedRevision:proposed.proposal.revision,requestId:randomUUID()}));proposed=await ok(dev.submitKnowledgeProposal(ws,pid,action(proposed)))
 const stale=await ok(dev.createKnowledgeProposal(ws,{content:candidate,submit:true,requestId:randomUUID()}))
 const approval=review(proposed,'approve');proposed=await ok(admin.reviewKnowledgeProposal(ws,pid,approval));assert.equal((await ok(admin.reviewKnowledgeProposal(ws,pid,approval))).proposal.publishedVersionId,proposed.proposal.publishedVersionId)
 await fails(admin.reviewKnowledgeProposal(ws,stale.proposal.proposalId,review(stale,'approve')),'KNOWLEDGE_BASE_CHANGED')
 const published=await ok(reader.readKnowledge(ws,base.item.knowledgeId));assert.equal(published.item.version,2);assert.ok(published.current.version.contributors.includes(account));assert.ok(published.current.text.includes('本人补充'))
 assert.equal((await ok(reader.readKnowledgeVersion(ws,base.item.knowledgeId,base.item.currentVersionId))).text,base.current.text)
 const id=published.item.knowledgeId,version=published.item.currentVersionId
 const feedback={value:'expired',note:'说明只给本人和管理员',requestId:randomUUID()};await ok(reader.setKnowledgeFeedback(ws,id,version,feedback));await ok(reader.setKnowledgeFeedback(ws,id,version,feedback));assert.equal((await ok(reader.readKnowledgeFeedback(ws,id,version))).expiredCount,1)
 assert.equal((await ok(dev.readKnowledgeFeedback(ws,id,version))).note,'');await fails(dev.readKnowledgeReview(ws,id,null),'WORKSPACE_ADMIN_REQUIRED')
 assert.ok((await ok(admin.listKnowledgeReviews(ws,null))).items.some(x=>x.knowledgeId===id))
 const recheck=await ok(admin.readKnowledgeReview(ws,id,null));assert.ok(recheck.events.some(e=>e.note===feedback.note))
 await ok(admin.confirmKnowledgeReview(ws,id,{expectedItemVersion:published.item.version,currentVersionId:version,feedbackWatermark:recheck.item.health.feedbackWatermark,action:'confirmed_valid',note:'已核对当前实现，仍然有效。',requestId:randomUUID()}))
 assert.ok(!(await ok(admin.listKnowledgeReviews(ws,null))).items.some(x=>x.knowledgeId===id))
 const readId=randomUUID(),n=(await ok(reader.readKnowledgeFeedback(ws,id,version))).versionReadCount
 await ok(reader.reportKnowledgeRead(ws,id,version,{readId}));await ok(reader.reportKnowledgeRead(ws,id,version,{readId}));assert.equal((await ok(reader.readKnowledgeFeedback(ws,id,version))).versionReadCount,n+1)
 const repo=await ok(admin.createRepository(ws,{name:'范围验证工程',remoteUrl:'https://example.invalid/team/repo.git',defaultBranch:'main',requestId:randomUUID()}))
 const rule=await ok(admin.createKnowledge(ws,{termKey:'rule-repo',category:'约定',title:'仓库规约',text:'该仓库使用稳定业务键。',...meta,level:'rule',scope:{kind:'repositories',repositoryIds:[repo.repositoryId]},requestId:randomUUID()}))
 const ks={origin,accountId:account,workspaceId:ws,generation:developer.personalIdentity().generation,repositoryIds:[]}
 assert.equal((await context.knowledge.rules(ks)).materials.length,0)
 execFileSync('git',['init','-q',cwd]);execFileSync('git',['-C',cwd,'remote','add','origin',repo.remoteUrl])
 ks.repositoryIds=await context.knowledge.repositories(ks,cwd);assert.deepEqual(ks.repositoryIds,[repo.repositoryId]);assert.ok((await context.knowledge.rules(ks)).materials.some(r=>r.referenceId.includes(rule.item.knowledgeId)))
 const huge=[];for(let i=0;i<3;i++)huge.push(await ok(admin.createKnowledge(ws,{termKey:'budget-'+i,category:'约定',title:'预算规约'+i,text:'x'.repeat(3000),...meta,level:'rule',requestId:randomUUID()})))
 const over=await context.knowledge.rules(ks);assert.equal(over.text,'');assert.equal(over.status.code,'RULE_CONTEXT_TOO_LARGE')
 await fails(admin.createKnowledge(ws,{termKey:'rule-too-big',category:'约定',title:'太长规约',text:'x'.repeat(4097),...meta,level:'rule',requestId:randomUUID()}),'RULE_BODY_TOO_LARGE')
 for(const item of huge)await ok(admin.archiveKnowledge(ws,item.item.knowledgeId,item.item.version,randomUUID()))
 const adoptedContent={...candidate,intent:'new',targetKnowledgeId:null,baseVersionId:null,baseItemVersion:null,candidate:{...candidate.candidate,termKey:'adoption-evidence',title:'复用来源提议',text:'明确引用已提交提议，保留其原贡献者。'},relatedReferences:[],sourceRefs:[{kind:'proposal',referenceId:stale.proposal.proposalId,projectId:null,revision:stale.proposal.revision}],generationKind:'manual'}
 await fails(reader.createKnowledgeProposal(ws,{content:adoptedContent,submit:true,requestId:randomUUID()}),'WORKSPACE_ADMIN_REQUIRED')
 let adopted=await ok(admin.createKnowledgeProposal(ws,{content:adoptedContent,submit:true,requestId:randomUUID()}));adopted=await ok(admin.reviewKnowledgeProposal(ws,adopted.proposal.proposalId,review(adopted,'approve')))
 assert.ok((await ok(reader.readKnowledge(ws,adopted.proposal.publishedKnowledgeId))).current.version.contributors.includes(account))
 const evidence={result:'PASS',origin,workspaceId:ws,knowledgeId:id,versionId:version,proposalId:pid,controlledAgent:true,realJavaMySql:true,actualMcpReads:1,formalTokenPreserved:true,originProposalContribution:true,modelGateway:false,privateDraft:true,returnResubmit:true,concurrentBaselineConflict:true,publishedContributors:true,oldVersionUnchanged:true,feedbackReview:true,readDedup:true,scopeMatch:true,ruleGroupBudget:true,sourceScope:scope,sourceTurn}
 await writeFile(join(root,'api-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log('PASS：真实Java/MySQL、受控本机ACP起草→提交→退回重提→批准→读取→反馈/复核')
}finally{await drafting.dispose();await coordinator.dispose();await context.dispose();await runtime.host.close();developer.dispose()}
