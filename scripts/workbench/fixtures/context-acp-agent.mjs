/** HC-233 受控 ACP Agent：实际消费 session MCP 配置、prompt 正文并通过 HTTP 调用业务工具；不调用模型。 */
import { createInterface } from "node:readline"
import { appendFile } from "node:fs/promises"
let setup, sawBaseline = false
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const call = async (method, params) => {
  const server = setup.mcpServers.find(s => s.name === "workbench-context")
  if (!server) throw new Error("MCP 配置未送达")
  const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(server.headers.map(h => [h.name, h.value])) }, body: JSON.stringify({ jsonrpc: "2.0", id: `agent-${method}`, method, params }) })
  const rpc = await response.json()
  if (!response.ok || rpc.error || rpc.result?.isError) throw new Error(JSON.stringify(rpc))
  return rpc.result
}
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    if (message.method === "initialize") write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: true, mcpCapabilities: { http: process.env.HC233_NO_HTTP !== "1" } }, agentInfo: { name: "hc233-controlled", version: "1" } } })
    else if (message.method === "session/new" || message.method === "session/load") {
      setup = message.params
      sawBaseline = false
      if (process.env.HC233_SETUP_REPORT) {
        const tools = setup.mcpServers.some(s => s.name === "workbench-context") ? (await call("tools/list", {})).tools.map(t => t.name) : []
        await appendFile(process.env.HC233_SETUP_REPORT, JSON.stringify({ method: message.method, servers: setup.mcpServers.map(s => s.name), tools }) + "\n")
      }
      write({ jsonrpc: "2.0", id: message.id, result: message.method === "session/new" ? { sessionId: "hc233-native" } : {} })
    } else if (message.method === "session/prompt") {
      const prompt = message.params.prompt.filter(b => b.type === "text").map(b => b.text).join("\n")
      if (prompt === "HC233_PLAIN_BIND_SMOKE") {
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "普通会话继续" } } } })
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        continue
      }
      if (!sawBaseline) {
        if (!prompt.includes("团队工程概览") || !prompt.includes("personal.md") || !prompt.includes("其他工程") || !prompt.includes("propose_project_memory_update")) throw new Error("首轮基线完整正文或提醒未实际送达")
        sawBaseline = true
      }
      const init = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "controlled", version: "1" } })
      if (!init.instructions?.includes("list_team_knowledge")) throw new Error("MCP 常驻 instructions 缺失")
      const listed = await call("tools/list", {})
      if (listed.tools.length !== 4) throw new Error("工具列表不全")
      const knowledge = await call("tools/call", { name: "list_team_knowledge", arguments: {} })
      const title = JSON.parse(knowledge.content[0].text).items[0]
      const read = await call("tools/call", { name: "read_team_knowledge", arguments: { referenceId: title.referenceId } })
      const readBody = JSON.parse(read.content[0].text)
      if (!readBody.alreadyRead) {
        if (!readBody.text.includes("已发布规范正文")) throw new Error("固定版本正文未读取")
      } else {
        const forced = await call("tools/call", { name: "read_team_knowledge", arguments: { referenceId: title.referenceId, force: true } })
        if (!JSON.parse(forced.content[0].text).text.includes("已发布规范正文")) throw new Error("force 重读固定版本正文失败")
      }
      const proposed = await call("tools/call", { name: "propose_project_memory_update", arguments: { operation: "upsert", kind: "team_repository", baseEntryRevision: 0, fields: { name: "Agent归纳工程", summary: "从本轮实际读取的团队规范确认工程用途。", aliases: ["agent-smoke"] }, sourceIds: [title.referenceId] } })
      const status = JSON.parse(proposed.content[0].text).status
      if (!["pending", "no_change"].includes(status)) throw new Error(`提案失败:${status}`)
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `受控Agent已实际读取固定知识并提案:${status}` } } } })
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
    } else if (message.method === "session/cancel") write({ jsonrpc: "2.0", id: message.id, result: {} })
    else write({ jsonrpc: "2.0", id: message.id, result: {} })
  } catch (error) { process.stderr.write(`${error.stack}\n`); process.exit(2) }
}
