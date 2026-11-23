/**
 * 桌面管理的单个回环 HTTP MCP 服务。上游提供已绑定的短期凭据与四个业务工具。
 * POST JSON-RPC → 验证 Host/Origin/凭据/请求大小 → 调用业务 → JSON MCP 结果。
 * 使用无服务端会话的 Streamable HTTP JSON 响应；不启动额外模型或远程执行通道。
 */
import { createServer, type Server, type IncomingMessage } from "node:http"
import { timingSafeEqual } from "node:crypto"

const string = { type: "string" }
const fields = {
  name: string, summary: string, aliases: { type: "array", items: string }, projectIds: { type: "array", items: string },
  repositoryId: string, repositoryIds: { type: "array", items: string }, relatedProjectIds: { type: "array", items: string },
  remoteUrl: string, upstreamUrl: string, rootPath: string, relativePath: string,
}
const kinds = { type: "string", enum: ["team_project", "team_repository", "personal_directory"] }
export const contextTools = [
  { name: "query_project_memory", description: "查询当前账号和会话所属团队的本机记忆、来源及最新条目修订号。最多10条/8KiB，hasMore只约束查询。", inputSchema: { type: "object", properties: { query: string, repositoryId: string, entryId: string, kind: kinds }, additionalProperties: false } },
  { name: "propose_project_memory_update", description: "结束回答前提交有已读sourceIds依据的条目变更。已有条目使用查询得到的baseEntryRevision，新条目使用0。pending尚未保存，只有本轮正常终态才能提交。个人路径须本人确认；冲突时先核实。", inputSchema: { type: "object", properties: { operation: { type: "string", enum: ["upsert", "remove"] }, kind: kinds, entryId: string, baseEntryRevision: { type: "integer", minimum: 0 }, fields: { type: "object", properties: fields, additionalProperties: false }, sourceIds: { type: "array", items: string, minItems: 1 } }, required: ["operation", "kind", "baseEntryRevision", "sourceIds"], additionalProperties: false } },
  { name: "list_team_knowledge", description: "按标题查找当前团队知识，仅返回标题与固定版本引用，沿真实nextAfterId翻页。", inputSchema: { type: "object", properties: { query: string, afterId: string }, additionalProperties: false } },
  { name: "read_team_knowledge", description: "读取 knowledge:<知识ID>:<版本ID> 对应的固定版本正文与来源。不会创建或改写团队知识。", inputSchema: { type: "object", properties: { referenceId: string }, required: ["referenceId"], additionalProperties: false } },
] as const

/** 凭据比较不随首个不匹配字节提前返回；不存在或过期的凭据统一拒绝。 */
export function sameToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error("请求超过64KiB。")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export class ContextMcpServer {
  #server?: Server
  #starting?: Promise<string>
  #url?: string
  constructor(private readonly authorized: (token: string) => boolean, private readonly invoke: (token: string, name: string, args: unknown, callId: string) => Promise<unknown>) {}
  /** 同一桌面服务只监听一个系统分配端口；每个Agent会话在请求头携带自己的临时凭据。 */
  start(): Promise<string> {
    if (this.#starting) return this.#starting
    this.#starting = new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        const send = (status: number, result?: unknown) => {
          response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
          response.end(result === undefined ? undefined : JSON.stringify(result))
        }
        if (request.url !== "/mcp" || request.headers.host !== new URL(this.#url!).host || request.headers.origin && request.headers.origin !== new URL(this.#url!).origin) return send(403)
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? ""
        if (!this.authorized(token)) return send(401)
        if (request.method !== "POST") return send(405)
        if (!request.headers["content-type"]?.startsWith("application/json")) return send(415)
        let rpc: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown } }
        try { rpc = await body(request) } catch { return send(400) }
        if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string"
          || rpc.id !== undefined && typeof rpc.id !== "string" && typeof rpc.id !== "number") return send(400)
        if (!this.authorized(token)) return send(401)
        if (rpc.id === undefined) return send(202)
        const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: rpc.id, result })
        if (rpc.method === "initialize") return reply({ protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(String(rpc.params?.protocolVersion)) ? rpc.params!.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "workbench-context", version: "1.0.0" } })
        if (rpc.method === "ping") return reply({})
        if (rpc.method === "tools/list") return reply({ tools: contextTools })
        if (rpc.method !== "tools/call" || typeof rpc.params?.name !== "string") return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "不支持的 MCP 方法。" } })
        try {
          const result = await this.invoke(token, rpc.params.name, rpc.params.arguments ?? {}, String(rpc.id))
          if (!this.authorized(token)) return send(401)
          const status = (result as { status?: string })?.status
          reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, ...(["error", "conflict"].includes(status ?? "") ? { isError: true } : {}) })
        } catch (error) {
          reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "工具调用失败。" }] })
        }
      })
      server.requestTimeout = 30_000
      server.headersTimeout = 10_000
      this.#server = server
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") return reject(new Error("无法分配本机 MCP 端口。"))
        this.#url = `http://127.0.0.1:${address.port}/mcp`
        resolve(this.#url)
      })
    })
    return this.#starting
  }
  async close(): Promise<void> {
    const server = this.#server
    if (!server) return
    this.#server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    this.#starting = undefined
    this.#url = undefined
  }
}
