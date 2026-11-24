/** 受控 ACP 冒烟 Agent：真实 HTTP MCP 检索/读取/结构化候选，不调用模型或读取真实密钥。 */
import { createInterface } from 'node:readline'
let setup
const write=value=>process.stdout.write(JSON.stringify(value)+'\n')
let sequence=0
async function call(method,params){const server=setup.mcpServers.find(s=>s.name==='workbench-context');if(!server)throw Error('缺少MCP');const r=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});const body=await r.json();if(!r.ok||body.error||body.result?.isError)throw Error(JSON.stringify(body));return body.result}
for await(const line of createInterface({input:process.stdin})){
 try{const m=JSON.parse(line);if(m.id===undefined)continue
 if(m.method==='initialize')write({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{mcpCapabilities:{http:true}},agentInfo:{name:'controlled-knowledge-draft',version:'1'}}})
 else if(m.method==='session/new'){setup=m.params;write({jsonrpc:'2.0',id:m.id,result:{sessionId:'draft-native'}})}
 else if(m.method==='session/prompt'){
  const prompt=m.params.prompt.filter(x=>x.type==='text').map(x=>x.text).join('\n')
  if(!prompt.includes('propose_team_knowledge_draft')){
   write({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'已确认：退款回调必须以业务幂等键防止重复记账。'}}}})
  }else{
   const tools=(await call('tools/list',{})).tools.map(t=>t.name);if(tools.length!==3||tools.includes('propose_project_memory_update'))throw Error('起草凭据权限不符')
   const list=JSON.parse((await call('tools/call',{name:'list_team_knowledge',arguments:{query:'回调',scope:'all'}})).content[0].text),item=list.items.find(i=>i.title==='回调幂等经验')??list.items[0]
   if(!item)throw Error('未发现已发布基线')
   const read=JSON.parse((await call('tools/call',{name:'read_team_knowledge',arguments:{referenceId:item.referenceId}})).content[0].text)
   const repeated=JSON.parse((await call('tools/call',{name:'read_team_knowledge',arguments:{referenceId:item.referenceId}})).content[0].text);if(!read.text||!repeated.alreadyRead)throw Error('固定版读取或同轮去重失败')
   const [,knowledgeId,versionId]=item.referenceId.split(':')
   const content={intent:'supplement',targetKnowledgeId:knowledgeId,baseVersionId:versionId,baseItemVersion:item.version,candidate:{termKey:'callback-base',category:'经验',title:'回调幂等经验',text:read.text+'\n补充：退款重试采用稳定业务幂等键，并在同一事务核对已记账状态。',level:'experience',scope:{kind:'workspace',repositoryIds:[]},contentType:'article'},relatedReferences:[{knowledgeId,versionId}],sourceSummary:'本人定稿确认退款重复投递问题及幂等处理方案。',sourceRefs:[],generationKind:'agent'}
   await call('tools/call',{name:'propose_team_knowledge_draft',arguments:{content}})
   write({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'tool_call',toolCallId:'knowledge-read',title:'read_team_knowledge',kind:'read',status:'completed',rawOutput:read,content:[{type:'content',content:{type:'text',text:JSON.stringify(read)}}]}}})
   write({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'已实际检索、读取固定版本并形成补充草稿。'}}}})
  }
  write({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})
 }else if(m.method==='session/cancel')write({jsonrpc:'2.0',id:m.id,result:{}})
 else write({jsonrpc:'2.0',id:m.id,result:{}})
 }catch(e){process.stderr.write(String(e.stack)+'\n');process.exit(2)}
}
