/** HC-240 必要真实 API 冒烟：独立账号、真实角色和事务交接，不调用模型。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { CollaborationClient } from '../../packages/collaboration-client/dist/index.js'
const [origin,evidence]=process.argv.slice(2)
const clients=Array.from({length:5},()=>new CollaborationClient(origin))
const ok=async promise=>{const r=await promise;assert.ok(r.ok,JSON.stringify(r));return r.value}
const fails=async(promise,code)=>{const r=await promise;assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.error.code,code);return r}
const me=await Promise.all(clients.map((c,i)=>ok(c.signIn(String(80278667+i)))))
const [a,b,c,d,e]=clients, [au,bu,cu,du,eu]=me.map(x=>x.user.id),ws=me[0].workspaces[0].id
const member=async user=>(await ok(a.listMembers(ws))).members.find(m=>m.user.id===user)
const change=(client,user,role,version)=>client.changeWorkspaceRole(ws,user,{role,expectedVersion:version,requestId:randomUUID()})
assert.equal(me[0].workspaces[0].role,'admin');assert.equal(me[1].workspaces[0].role,'developer')
await fails(change(b,bu,'admin',1),'WORKSPACE_ADMIN_REQUIRED')
await fails(change(a,au,'developer',1),'LAST_WORKSPACE_ADMIN')
await ok(change(a,bu,'admin',(await member(bu)).version))
const concurrent=await Promise.all([change(a,au,'developer',(await member(au)).version),change(b,bu,'developer',(await member(bu)).version)])
assert.equal(concurrent.filter(r=>r.ok).length,1)
assert.equal(concurrent.find(r=>!r.ok).error.code,'LAST_WORKSPACE_ADMIN')
const after=(await ok(a.listMembers(ws))).members
assert.equal(after.filter(m=>m.role==='admin'&&m.status==='active').length,1)
if(after.find(m=>m.user.id===au).role!=='admin')await ok(change(b,au,'admin',(await member(au)).version))
if((await member(bu)).role==='admin')await ok(change(a,bu,'developer',(await member(bu)).version))
await fails(b.createKnowledge(ws,{level:'experience',scope:{kind:'workspace',repositoryIds:[]},contentType:'article',requestId:randomUUID(),termKey:'forbidden',category:'经验',title:'不能直接发布',text:'无权限'}),'WORKSPACE_ADMIN_REQUIRED')
const knowledge=await ok(a.createKnowledge(ws,{level:'experience',scope:{kind:'workspace',repositoryIds:[]},contentType:'article',requestId:randomUUID(),termKey:'role-smoke',category:'经验',title:'历史贡献',text:'固定版本不得因角色变化而改写'}))
const repo=await ok(a.createRepository(ws,{name:'交接仓库',remoteUrl:'https://example.invalid/hc240.git',ownerUserId:bu,requestId:randomUUID()}))
await fails(b.createRepository(ws,{name:'禁止登记',remoteUrl:'https://example.invalid/no.git',requestId:randomUUID()}),'WORKSPACE_ADMIN_REQUIRED')
const project='00000000-0000-4000-8000-0000000000a2'
const conv=await ok(b.registerProjectConversation(ws,project,{title:'原成员已共享历史',requestId:randomUUID()}))
const conversationId=conv.conversation.conversationId
assert.ok(conversationId,JSON.stringify(conv))
await ok(b.syncConversation(ws,project,conversationId,{messages:[{sequence:1,type:'user',occurredAtMs:Date.now(),payload:JSON.stringify({text:'保留历史作者'})},{sequence:2,type:'assistant',occurredAtMs:Date.now(),payload:JSON.stringify({text:'固定共享历史'})}],brief:{status:'idle',briefText:'交接前定稿',briefSource:'rule'}}))
let task=await ok(b.createTask(ws,project,{title:'离职执行与验收',description:'交接必须保留原发起人',assigneeId:bu,requestId:randomUUID()}))
task=await ok(b.transitionTask(ws,project,task.task.taskId,{targetStatus:'doing',expectedVersion:task.task.version,requestId:randomUUID()}))
task=await ok(b.linkTaskConversation(ws,project,task.task.taskId,{conversationId,expectedVersion:task.task.version,requestId:randomUUID()}))
const preview=await ok(a.previewWorkspaceRemoval(ws,bu));assert.equal(preview.nextAfterId,null)
const removal=prior=>({requestId:randomUUID(),expectedMemberVersion:prior.targetMember.version,previewVersion:prior.previewVersion,defaultSuccessorUserId:cu,projectSuccessors:[],taskSuccessors:[],repositorySuccessors:[{repositoryId:repo.repositoryId,userId:null}],addToProjects:[],confirmResetTasks:true,confirmRetainHistory:true})
task=await ok(b.transitionTask(ws,project,task.task.taskId,{targetStatus:'review',expectedVersion:task.task.version,requestId:randomUUID()}))
await fails(a.removeWorkspaceMember(ws,bu,removal(preview)),'HANDOFF_PREVIEW_STALE')
assert.equal((await member(bu)).status,'active');assert.equal((await ok(b.getProject(ws,project))).project.ownerUserId,bu)
const fresh=await ok(a.previewWorkspaceRemoval(ws,bu)),request=removal(fresh)
await fails(a.removeWorkspaceMember(ws,bu,request),'PROJECT_SUCCESSOR_CONFIRMATION_REQUIRED')
assert.equal((await member(bu)).status,'active')
request.addToProjects=[{projectId:project,userId:cu}]
const removed=await ok(a.removeWorkspaceMember(ws,bu,request));assert.equal(removed.member.status,'removed')
assert.deepEqual(await ok(a.removeWorkspaceMember(ws,bu,request)),removed)
await fails(b.getWorkspaceAccess(ws),'WORKSPACE_MEMBER_REQUIRED')
await fails(b.readKnowledgeVersion(ws,knowledge.item.knowledgeId,knowledge.current.version.versionId),'WORKSPACE_MEMBER_REQUIRED')
const transferred=await ok(c.readTask(ws,project,task.task.taskId))
assert.equal(transferred.task.assigneeId,cu);assert.equal(transferred.task.creatorId,bu);assert.equal(transferred.task.status,'todo');assert.equal(transferred.task.conversationId,null)
assert.equal(transferred.transitions.at(-1).handoff.previousConversationId,conversationId)
const history=await ok(c.readProjectConversationHistory(ws,project,conversationId,0,50));assert.equal(history.messages.length,2)
const source=await ok(c.getProjectConversation(ws,project,conversationId));assert.equal(source.conversation.ownerUserId,bu);assert.equal(source.conversation.shareStatus,'stopped')
assert.equal((await ok(c.getProject(ws,project))).project.ownerUserId,cu)
assert.equal((await ok(c.listRepositories(ws))).repositories.find(r=>r.repositoryId===repo.repositoryId).ownerUserId,null)
let accepted=await ok(c.transitionTask(ws,project,task.task.taskId,{targetStatus:'doing',expectedVersion:transferred.task.version,requestId:randomUUID()}))
accepted=await ok(c.transitionTask(ws,project,task.task.taskId,{targetStatus:'review',expectedVersion:accepted.task.version,requestId:randomUUID()}))
accepted=await ok(c.transitionTask(ws,project,task.task.taskId,{targetStatus:'done',expectedVersion:accepted.task.version,requestId:randomUUID()}))
assert.equal(accepted.task.status,'done')
const fixed=await ok(c.readKnowledgeVersion(ws,knowledge.item.knowledgeId,knowledge.current.version.versionId));assert.equal(fixed.text,'固定版本不得因角色变化而改写')
// 为后续正式桌面准备一条仍未交接的任务，仍通过真实用户入口创建。
const p1='00000000-0000-4000-8000-0000000000a1'
await ok(a.addProjectMember(ws,p1,{userId:eu,requestId:randomUUID()}))
const uiTask=await ok(a.createTask(ws,p1,{title:'正式界面交接任务',description:'由设置弹窗完成真实交接',assigneeId:eu,requestId:randomUUID()}))
const result={result:'PASS',workspace:ws,roleChange:true,developerDenied:true,lastAdmin:true,concurrentLastAdmin:true,stalePreviewAtomic:true,explicitProjectAccess:true,idempotentRemoval:true,creatorPreserved:true,creatorDutyAccepted:true,historyReadOnly:true,repositoryUnclaimed:true,uiTarget:eu,uiSuccessor:cu,uiTaskId:uiTask.task.taskId}
await writeFile(evidence,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
for(const client of clients)client.dispose()
