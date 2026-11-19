/** 从真实 stdio 验证配置模式、协商参数、静默重建与单次历史交接。 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { LocalAcpHost, type LocalAcpEvent, type LocalAcpSession, type LocalAcpSessionUpdateEvent } from "../dist/index.js"

const fixture = `
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const sessionId = "new-"+process.pid;
const write = event => process.stdout.write(JSON.stringify({jsonrpc:"2.0",...event})+"\\n");
const config = value => [{id:"execution",name:"执行模式",type:"select",category:"mode",currentValue:value,
  options:[{value:"work",name:"执行"},{value:"plan",name:"计划"}]}];
const chunk = (sessionId,text) => write({method:"session/update",params:{sessionId,update:{
  sessionUpdate:"agent_message_chunk",content:{type:"text",text},
}}});
createInterface({input:process.stdin}).on("line",line=>{
  const {method,params,id}=JSON.parse(line);
  fs.appendFileSync(process.env.TRACE, JSON.stringify({pid:process.pid,method,params})+"\\n");
  if(method==="initialize") return write({id,result:{protocolVersion:params.protocolVersion,authMethods:[],
    agentCapabilities:{loadSession:true,sessionCapabilities:{additionalDirectories:{},resume:{}},mcpCapabilities:{http:true}}}});
  if(method==="session/new") return write({id,result:{sessionId,configOptions:config("work")}});
  if(method==="session/load") {
    chunk(params.sessionId,"partial replay");
    setTimeout(()=>{chunk(params.sessionId,"late replay");write({id,result:{configOptions:config("work")}});},10000).unref();
    return;
  }
  if(method==="session/set_config_option") {
    if(params.configId!=="execution") return write({id,error:{code:-32602,message:"wrong option"}});
    return write({id,result:{configOptions:config(params.value)}});
  }
  if(method==="session/prompt") {
    chunk(params.sessionId,"ok");
    return write({id,result:{stopReason:"end_turn"}});
  }
});
`
const scope = { accountId: "me", workspaceId: "team", projectId: "project", conversationId: "thread" }

function prompt(session: LocalAcpSession) {
  return new Promise<LocalAcpEvent>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("轮次超时")) }, 3_000)
    const stop = session.subscribe(event => {
      if (event.type === "completed" || event.type === "failed") { clearTimeout(timer); stop(); resolve(event) }
    })
    const receipt = session.sendPrompt([{ type: "text", text: "本轮原文" }], [{ type: "text", text: "一次历史引用" }])
    if (receipt.status !== "accepted") { clearTimeout(timer); stop(); reject(new Error(receipt.reason)) }
  })
}

test("配置型模式、协商参数、回放静默重建及历史只注入一次", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc234-acp-"))
  const cwd = join(root, "cwd"), extra = join(root, "extra"), trace = join(root, "trace")
  await Promise.all([mkdir(cwd), mkdir(extra)])
  const extraClientCapabilitiesMeta = { example: { version: 1 } }
  const cmd = { executable: process.execPath, args: ["-e", fixture], env: { ...process.env, TRACE: trace } }
  const hosts: LocalAcpHost[] = []
  const host = (restorePolicy: "strict" | "fallback-new") => {
    const instance = new LocalAcpHost(cmd, {
      bindingDirectory: join(root, "bindings"), handshakeTimeoutMs: 1200, sessionLoadReplayIdleMs: 70,
      extraClientCapabilitiesMeta, additionalDirectories: [extra], restorePolicy,
      mcpServers: [
        { type: "http", name: "allowed", url: "https://example.invalid/mcp", headers: [] },
        { type: "sse", name: "skipped", url: "https://example.invalid/sse", headers: [] },
      ],
    })
    hosts.push(instance)
    return instance
  }
  try {
    const original = host("fallback-new")
    const first = await original.bind(scope, cwd)
    await first.connect()
    assert.equal(first.getState().currentModeId, "work")
    assert.match(first.getState().setupDiagnostics?.[0] ?? "", /MCP/)
    await first.setMode("plan")
    assert.equal(first.getState().currentModeId, "plan")
    await original.close()

    const strict = host("strict")
    const failed = await prompt(await strict.bind(scope, cwd))
    assert.ok(failed.type === "failed" && failed.reason === "session-restore-failed")
    await strict.close()

    const fallback = host("fallback-new")
    const session = await fallback.bind(scope, cwd)
    const events: LocalAcpSessionUpdateEvent[] = []
    session.subscribeSession(event => events.push(event))
    await session.connect()
    assert.equal(session.getState().restoreStatus.kind, "reset")
    assert.equal(events.some(event => event.type === "replay"), false)
    assert.equal((await prompt(session)).type, "completed")
    assert.equal((await prompt(session)).type, "completed")
    const requests = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    assert.deepEqual(requests.find(item => item.method === "initialize").params.clientCapabilities._meta, extraClientCapabilitiesMeta)
    for (const created of requests.filter(item => item.method === "session/new" || item.method === "session/load")) {
      assert.deepEqual(created.params.additionalDirectories, [await realpath(extra)])
      assert.deepEqual(created.params.mcpServers.map((item: { name: string }) => item.name), ["allowed"])
    }
    const loads = requests.filter(item => item.method === "session/load")
    const creates = requests.filter(item => item.method === "session/new")
    assert.equal(loads.length, 2)
    assert.equal(creates.length, 2)
    assert.notEqual(loads[1].pid, creates[1].pid)
    assert.deepEqual(requests.filter(item => item.method === "session/prompt").map(item =>
      item.params.prompt.map((block: { text: string }) => block.text)), [["一次历史引用", "本轮原文"], ["本轮原文"]])
    await assert.rejects(fallback.bind({ ...scope, conversationId: "bad" }, cwd, {
      mcpServers: [{ type: "http", name: "bad", url: "https://u:p@example.invalid/", headers: [] }],
    }), /不得包含登录信息/)
  } finally {
    await Promise.all(hosts.map(instance => instance.close()))
    await rm(root, { recursive: true, force: true })
  }
})
