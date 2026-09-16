/** 内部代码索引 adapter：由平台包自带 Node 加载，stdout 仅输出 Harness JSONL。 */
import { stat as statFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { dirname, isAbsolute, join, resolve } from "node:path"

export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph"
export const CODEGRAPH_VERSION = "1.1.6"

export function adapterManifest() {
  return { package: CODEGRAPH_PACKAGE, version: CODEGRAPH_VERSION, role: "code-index-adapter" }
}

function normalizedProgress(progress) {
  if (!progress || typeof progress !== "object") return null
  const completed = progress.current
  const total = progress.total
  if (!Number.isSafeInteger(completed) || completed < 0) return null
  const value = {
    type: "progress",
    phase: progress.phase === "resolving" ? "resolving" : "indexing",
    completed,
  }
  if (Number.isSafeInteger(total) && total >= completed) value.total = total
  return value
}

async function fileSize(path, stat) {
  try {
    const value = await stat(path)
    return Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0
  } catch {
    return 0
  }
}

/** 启动私有查询会话；SDK 可注入，stdin 只接受 Harness JSONL。 */
export async function runServe({ workspace, sdk, emit, input }) {
  if (typeof workspace !== "string" || !isAbsolute(workspace)) {
    emit({ type: "failed", code: "INVALID_REQUEST" })
    return 2
  }
  let graph
  let handler
  try {
    graph = await sdk.CodeGraph.open(workspace)
    handler = new sdk.ToolHandler(graph)
    emit({ type: "ready", watcher: "ready" })
    if (input == null) return 0
    for await (const line of input) {
      let request
      try {
        request = JSON.parse(String(line))
      } catch {
        continue
      }
      if (!request || request.type !== "explore" || typeof request.id !== "string") continue
      const maxFiles = Number.isSafeInteger(request.max_files) ? request.max_files : 8
      let text
      try {
        const result = await handler.execute("codegraph_explore", {
          query: String(request.query ?? ""),
          maxFiles,
        })
        text = result?.content
          ?.filter(item => item?.type === "text" && typeof item.text === "string")
          .map(item => item.text)
          .join("\n") ?? ""
      } catch {
        text = "代码索引查询失败。请改用 glob、grep 或 read_file。"
      }
      emit({ type: "result", id: request.id, text })
    }
    return 0
  } catch {
    emit({ type: "failed", code: "QUERY_FAILED" })
    return 1
  } finally {
    try {
      handler?.closeAll()
    } catch {
      // 私有查询资源关闭失败不能污染 stdout。
    }
    try {
      graph?.close()
    } catch {
      // 图连接关闭失败由 Host 进程监督收敛。
    }
  }
}

/** 执行一次首建；SDK 可注入仅用于隔离契约测试。 */
export async function runAdapter({ operation, workspace, sdk, emit, stat = statFile }) {
  if (operation === "serve") {
    return runServe({ workspace, sdk, emit, input: null })
  }
  if (!["initialize", "sync", "rebuild"].includes(operation) || typeof workspace !== "string" || !isAbsolute(workspace)) {
    emit({ type: "failed", code: "INVALID_REQUEST" })
    return 2
  }
  emit({ type: "started" })
  let graph
  try {
    graph = operation === "initialize"
      ? await sdk.CodeGraph.init(workspace, { index: false })
      : operation === "rebuild"
        ? await sdk.CodeGraph.recreate(workspace)
        : await sdk.CodeGraph.open(workspace)
    const build = operation === "sync" ? graph.sync.bind(graph) : graph.indexAll.bind(graph)
    const result = await build({
      onProgress(progress) {
        const event = normalizedProgress(progress)
        if (event) emit(event)
      },
    })
    if (result && result.success === false) throw new Error("index failed")
    const stats = graph.getStats()
    const dataDirectory = process.env.CODEGRAPH_DIR || ".harness-index"
    const walBytes = await fileSize(join(workspace, dataDirectory, "codegraph.db-wal"), stat)
    emit({
      type: "succeeded",
      stats: {
        files: stats.fileCount,
        symbols: stats.nodeCount,
        relationships: stats.edgeCount,
        db_bytes: stats.dbSizeBytes,
        wal_bytes: walBytes,
      },
    })
    return 0
  } catch {
    emit({ type: "failed", code: "INDEX_FAILED" })
    return 1
  } finally {
    try {
      graph?.close()
    } catch {
      // 关闭失败由非零/后续状态校验收敛，不污染 stdout。
    }
  }
}

function parseArgs(argv) {
  const operation = argv[0]
  const workspaceIndex = argv.indexOf("--workspace")
  const workspace = workspaceIndex >= 0 ? argv[workspaceIndex + 1] : undefined
  return { operation, workspace }
}

async function* stdinLines() {
  const reader = createInterface({ input: process.stdin })
  for await (const line of reader) {
    if (line) yield line
  }
}

async function main() {
  const require = createRequire(import.meta.url)
  const coreSdk = require(CODEGRAPH_PACKAGE)
  const platformPackage = `${CODEGRAPH_PACKAGE}-${process.platform}-${process.arch}`
  const platformRoot = dirname(require.resolve(`${platformPackage}/package.json`))
  const { ToolHandler } = require(join(platformRoot, "lib", "dist", "mcp", "index.js"))
  const sdk = { ...coreSdk, ToolHandler }
  const args = parseArgs(process.argv.slice(2))
  const emit = (value) => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  if (args.operation === "serve") {
    process.exitCode = await runServe({
      workspace: args.workspace,
      sdk,
      emit,
      input: stdinLines(),
    })
    return
  }
  const exitCode = await runAdapter({
    ...args,
    sdk,
    emit,
  })
  process.exitCode = exitCode
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
