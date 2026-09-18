import { expect, test } from "vitest"

import { runAdapter, runServe } from "../src/code-index-adapter/index.mjs"

test("initialize emits bounded progress and validated terminal stats", async () => {
  const lines: unknown[] = []
  let closed = false
  const graph = {
    async indexAll({ onProgress }: { onProgress: (progress: unknown) => void }) {
      onProgress({ phase: "parsing", current: 2, total: 5, currentFile: "/secret/source.ts" })
      onProgress({ phase: "resolving", current: 3, total: 3 })
      return { success: true }
    },
    getStats() {
      return { fileCount: 5, nodeCount: 17, edgeCount: 9, dbSizeBytes: 2048 }
    },
    close() {
      closed = true
    },
  }
  const sdk = { CodeGraph: { async init() { return graph } } }

  const exitCode = await runAdapter({
    operation: "initialize",
    workspace: "/tmp/fixture",
    sdk,
    emit: value => lines.push(value),
    stat: async () => ({ size: 128 }),
  })

  expect(exitCode).toBe(0)
  expect(lines).toEqual([
    { type: "started" },
    { type: "progress", phase: "indexing", completed: 2, total: 5 },
    { type: "progress", phase: "resolving", completed: 3, total: 3 },
    {
      type: "succeeded",
      stats: { files: 5, symbols: 17, relationships: 9, db_bytes: 2048, wal_bytes: 128 },
    },
  ])
  expect(JSON.stringify(lines)).not.toContain("source.ts")
  expect(closed).toBe(true)
})

test("failed index emits only supplier-neutral terminal frame", async () => {
  const lines: unknown[] = []
  const sdk = {
    CodeGraph: {
      async init() {
        throw new Error("CodeGraph raw provider path /private/repo")
      },
    },
  }
  const exitCode = await runAdapter({
    operation: "initialize",
    workspace: "/tmp/fixture",
    sdk,
    emit: value => lines.push(value),
    stat: async () => ({ size: 0 }),
  })
  expect(exitCode).toBe(1)
  expect(lines).toEqual([{ type: "started" }, { type: "failed", code: "INDEX_FAILED" }])
})

test("serve emits ready then explore results without vendor names", async () => {
  const lines: unknown[] = []
  let closed = false
  const graph = { close() { closed = true } }
  class ToolHandler {
    constructor(received: unknown) {
      expect(received).toBe(graph)
    }

    async execute(name: string, args: Record<string, unknown>) {
      expect(name).toBe("codegraph_explore")
      expect(args).toEqual({ query: "UniqueMarker", maxFiles: 2 })
      return { content: [{ type: "text", text: "hit UniqueMarker" }] }
    }

    closeAll() {}
  }
  async function* input() {
    yield JSON.stringify({ type: "explore", id: "q1", query: "UniqueMarker", max_files: 2 })
  }
  const exitCode = await runServe({
    workspace: "/tmp/fixture",
    sdk: {
      CodeGraph: { async open() { return graph } },
      ToolHandler,
    },
    emit: value => lines.push(value),
    input: input(),
  })
  expect(exitCode).toBe(0)
  expect(lines).toEqual([
    { type: "ready", watcher: "ready" },
    { type: "result", id: "q1", text: "hit UniqueMarker" },
  ])
  expect(JSON.stringify(lines)).not.toContain("CodeGraph")
  expect(closed).toBe(true)
})

test.each([
  ["sync", "open", "sync"],
  ["rebuild", "recreate", "indexAll"],
] as const)("%s selects the matching graph lifecycle", async (operation, expectedOpen, expectedBuild) => {
  const calls: string[] = []
  const graph = {
    async sync() { calls.push("sync"); return { success: true } },
    async indexAll() { calls.push("indexAll"); return { success: true } },
    getStats() { return { fileCount: 1, nodeCount: 2, edgeCount: 1, dbSizeBytes: 8 } },
    close() {},
  }
  const sdk = {
    CodeGraph: {
      async open() { calls.push("open"); return graph },
      async recreate() { calls.push("recreate"); return graph },
    },
  }
  const exitCode = await runAdapter({
    operation,
    workspace: "/tmp/fixture",
    sdk,
    emit() {},
    stat: async () => ({ size: 0 }),
  })
  expect(exitCode).toBe(0)
  expect(calls).toEqual([expectedOpen, expectedBuild])
})

test("sync without explicit success still emits succeeded stats", async () => {
  const lines: unknown[] = []
  const graph = {
    async sync() { return undefined },
    getStats() { return { fileCount: 2, nodeCount: 3, edgeCount: 1, dbSizeBytes: 16 } },
    close() {},
  }
  const exitCode = await runAdapter({
    operation: "sync",
    workspace: "/tmp/fixture",
    sdk: { CodeGraph: { async open() { return graph } } },
    emit: value => lines.push(value),
    stat: async () => ({ size: 0 }),
  })
  expect(exitCode).toBe(0)
  expect(lines.at(-1)).toMatchObject({ type: "succeeded", stats: { files: 2, symbols: 3 } })
})

test("adapter rejects unsupported operation without loading the SDK", async () => {
  let loaded = false
  const lines: unknown[] = []
  const exitCode = await runAdapter({
    operation: "remove",
    workspace: "/tmp/fixture",
    sdk: new Proxy({}, { get() { loaded = true } }),
    emit: value => lines.push(value),
    stat: async () => ({ size: 0 }),
  })
  expect(exitCode).toBe(2)
  expect(loaded).toBe(false)
  expect(lines).toEqual([{ type: "failed", code: "INVALID_REQUEST" }])
})
