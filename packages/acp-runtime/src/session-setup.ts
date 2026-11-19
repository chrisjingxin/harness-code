/** 校验可信宿主提供的建会参数。只有 Agent 宣告的可选传输和目录能力才发送。 */
import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { AgentCapabilities, McpServer } from "@agentclientprotocol/sdk"
import type { LocalAcpSessionSetup } from "./types.js"

type Directory = { path: string; dev: bigint; ino: bigint }
export type PreparedSessionSetup = { directories: readonly Directory[]; servers: readonly McpServer[]; signature: string }

const valid = (value: unknown): value is string => typeof value === "string" && value.length <= 8192 && !value.includes("\0")

async function directory(path: string): Promise<Directory> {
  if (!valid(path) || !isAbsolute(path)) throw new Error("附加目录必须是受信任的绝对路径。")
  const canonical = await realpath(path)
  const info = await stat(canonical, { bigint: true })
  if (!info.isDirectory()) throw new Error("附加目录不可用。")
  return { path: canonical, dev: info.dev, ino: info.ino }
}

async function validateServer(value: McpServer): Promise<McpServer> {
  if (!value || !valid(value.name) || !value.name.trim()) throw new Error("MCP 服务名称无效。")
  if ("type" in value) {
    if (value.type !== "http" && value.type !== "sse") throw new Error("当前宿主仅配置 stdio、HTTP 或 SSE MCP。")
    if (!valid(value.url)) throw new Error("MCP URL 无效。")
    const url = new URL(value.url)
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.hash) {
      throw new Error("MCP 地址须使用 HTTPS 或本机回环 HTTP，且不得包含登录信息。")
    }
    if (!Array.isArray(value.headers) || value.headers.length > 64 || value.headers.some(item => !item
      || !valid(item.name) || !/^[!#$%&'*+.^_|~0-9A-Za-z-]+$/.test(item.name)
      || !valid(item.value) || /[\r\n]/.test(item.value))) throw new Error("MCP 请求头无效。")
    return { type: value.type, url: url.href, headers: structuredClone(value.headers), name: value.name }
  }
  if (!valid(value.command) || !isAbsolute(value.command)) throw new Error("stdio MCP 命令必须是已授权的绝对路径。")
  const command = await realpath(value.command)
  if (!(await stat(command)).isFile()) throw new Error("stdio MCP 命令不可用。")
  await access(command, constants.X_OK)
  if (!Array.isArray(value.args) || value.args.length > 128 || !value.args.every(valid)
    || !Array.isArray(value.env) || value.env.length > 128 || value.env.some(item => !item
      || !valid(item.name) || !item.name || item.name.includes("=") || !valid(item.value))) throw new Error("stdio MCP 参数无效。")
  return { name: value.name, command, args: [...value.args], env: structuredClone(value.env) }
}

export async function prepareSessionSetup(cwd: string, options: LocalAcpSessionSetup): Promise<PreparedSessionSetup> {
  const roots = options.additionalDirectories ?? []
  const servers = options.mcpServers ?? []
  if (!Array.isArray(roots) || roots.length > 32 || !Array.isArray(servers) || servers.length > 32) {
    throw new Error("ACP 目录或 MCP 配置超出上限。")
  }
  const directories = [...new Map((await Promise.all(roots.map(directory))).map(item => [item.path, item])).values()]
    .filter(item => item.path !== cwd)
  const validated = await Promise.all(servers.map(validateServer))
  return { directories, servers: validated, signature: JSON.stringify([
    directories.map(item => [item.path, String(item.dev), String(item.ino)]), validated,
  ]) }
}

export async function sessionSetupPayload(cwd: string, setup: PreparedSessionSetup, capabilities: AgentCapabilities | undefined) {
  const additionalDirectories: string[] = []
  const diagnostics: string[] = []
  if (setup.directories.length) {
    if (!capabilities?.sessionCapabilities?.additionalDirectories) diagnostics.push("Agent 未声明附加目录能力。")
    else for (const expected of setup.directories) {
      const current = await directory(expected.path)
      if (current.path !== expected.path || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error("ACP 附加目录已被替换，请重新授权。")
      }
      additionalDirectories.push(expected.path)
    }
  }
  const mcpServers = setup.servers.filter(server => !("type" in server)
    || server.type === "http" && capabilities?.mcpCapabilities?.http === true
    || server.type === "sse" && capabilities?.mcpCapabilities?.sse === true)
  if (mcpServers.length !== setup.servers.length) diagnostics.push("Agent 未声明已配置的 MCP 传输能力。")
  return { payload: { cwd, mcpServers, ...(additionalDirectories.length ? { additionalDirectories } : {}) }, diagnostics }
}
