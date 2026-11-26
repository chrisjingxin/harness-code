/** 233/241 正式逐轮冒烟 Agent：捕获实际 prompt，经真实 HTTP MCP 查询/提案，无模型或工程写操作。 */
import { createInterface } from 'node:readline'
import { appendFile } from 'node:fs/promises'
let setup, waitingCancel
const write=value=>process.stdout.write(JSON.stringify(value)+'\n')
const update=(sessionId,event)=>write({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:event}})
async function call(name,args={},id=name){
 const server=setup.mcpServers.find(s=>s.name==='workbench-context')
 const r=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})})
 const body=await r.json();if(!r.ok||body.error||body.result?.isError)throw Error(JSON.stringify(body));return JSON.parse(body.result.content[0].text)
}
async function prompt(m){
 const text=m.params.prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n')
 await appendFile(process.argv[2],JSON.stringify({prompt:m.params.prompt})+'\n')
 if(text.startsWith('HC241_CONTEXT_NONE')||text.startsWith('/context-smoke')){
  if(text.includes('<本机记忆'))throw Error('无团队或斜杠消息不应附带材料')
 }else{
  if(text.startsWith('HC241_CONTEXT_TWO')){
   if(!text.includes('<本机记忆 team.md（已更新）>')||!text.includes('跨轮验证工程'))throw Error('首轮保存未增量送达次轮')
   if(text.includes('<本机记忆 personal.md'))throw Error('未变更文档不应重复送达')
   const memory=await call('read_project_memory',{document:'team'})
   if(!memory.content.includes('跨轮验证工程'))throw Error('首轮更新没有即时保存')
  }else{
   if(text.startsWith('HC241_CONTEXT_ONE')&&(!text.includes('<本机记忆 team.md>')||!text.includes('<本机记忆 personal.md>')||!text.includes('update_project_memory')))throw Error('首轮基线/指引未送达')
   const items=(await call('list_team_knowledge',{scope:'all'})).items
   const rule=items.find(x=>x.title==='匹配仓库规约')
   if(rule){const duplicate=await call('read_team_knowledge',{referenceId:rule.referenceId},'rule-read');if(!duplicate.alreadyRead||duplicate.text)throw Error('已提供规约未登记')}
   const experience=items.find(x=>x.title==='真实工具知识')??items.find(x=>x.level!=='rule')
   if(experience){
    const read=await call('read_team_knowledge',{referenceId:experience.referenceId},'knowledge-read')
    if(!read.text&&!read.alreadyRead)throw Error('知识读取失败')
    if(!(await call('read_team_knowledge',{referenceId:experience.referenceId},'knowledge-repeat')).alreadyRead)throw Error('知识去重失败')
    update(m.params.sessionId,{sessionUpdate:'tool_call',toolCallId:'knowledge-read',title:'read_team_knowledge',kind:'read',status:'completed',rawOutput:read,content:[{type:'content',content:{type:'text',text:JSON.stringify(read)}}]})
   }
   const name=text.startsWith('HC241_CONTEXT_FAIL')?'失败后保留':text.startsWith('HC241_CONTEXT_CANCEL')?'取消后保留':'跨轮验证工程'
   const before=await call('read_project_memory',{document:'team'})
   const result=await call('update_project_memory',{document:'team',content:before.content+'\n## '+name+'\n普通工程信息，无需结构化证明。\n',expectedRevision:before.revision},'memory-write')
   if(result.status!=='saved')throw Error('必须在工具返回时立即saved')
   if(!(await call('read_project_memory',{document:'team'})).content.includes(name))throw Error('终态前文件未保存')
   update(m.params.sessionId,{sessionUpdate:'tool_call',toolCallId:'memory-write',title:'update_project_memory',kind:'other',status:'completed'})
   if(text.startsWith('HC241_CONTEXT_FAIL')){write({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'受控发送失败'}});return}
   if(text.startsWith('HC241_CONTEXT_CANCEL')){waitingCancel=m;return}
  }
 }
 update(m.params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'正式逐轮上下文验证完成'}})
 write({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
}
for await(const line of createInterface({input:process.stdin})){
 try{const m=JSON.parse(line)
  if(m.method==='session/cancel'){if(waitingCancel){write({jsonrpc:'2.0',id:waitingCancel.id,result:{stopReason:'end_turn'}});waitingCancel=undefined}if(m.id!==undefined)write({jsonrpc:'2.0',id:m.id,result:{}});continue}
  if(m.id===undefined)continue
  if(m.method==='initialize')write({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{mcpCapabilities:{http:true}},agentInfo:{name:'controlled-context-turn',version:'1'}}})
  else if(m.method==='session/new'){setup=m.params;write({jsonrpc:'2.0',id:m.id,result:{sessionId:'context-native'}})}
  else if(m.method==='session/prompt')void prompt(m).catch(e=>{process.stderr.write(String(e.stack)+'\n');write({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:String(e.message)}})})
  else write({jsonrpc:'2.0',id:m.id,result:{}})
 }catch(e){process.stderr.write(String(e.stack)+'\n');process.exit(2)}
}
