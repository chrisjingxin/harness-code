/** Thread catalog 游标分页：refresh 重置游标、loadMore 合并去重、防迟到/防重入。 */

import { expect, test } from "bun:test"
import type { ThreadSummary } from "@za38/protocol"

import { CatalogFeature } from "../../src/interactive/features/catalog-feature"
import type { FeatureContext } from "../../src/interactive/features/types"

const row = (id: string, updatedAt = 1000): ThreadSummary => ({
  thread_id: id, title: id, created_at_ms: updatedAt, updated_at_ms: updatedAt,
  first_message: "", latest_message: "", message_count: 0,
})

/** 构造只含 listThreads 的假网关 + 记录 publish 的最小 ctx；其余字段测试用不到。 */
function makeCtx(pages: Record<string | "null", { threads: ThreadSummary[]; nextCursor: string | null }>) {
  const calls: Array<string | null> = []
  let publishes = 0
  const ctx = {
    gateway: {
      async listThreads(cursor?: string) {
        const key = cursor ?? null
        calls.push(key)
        const page = pages[key as string]
        if (!page) throw new Error(`unexpected cursor ${key}`)
        return { threads: page.threads, nextCursor: page.nextCursor }
      },
    },
    publish: () => { publishes += 1 },
  } as unknown as FeatureContext
  return { ctx, calls, getPublishes: () => publishes }
}

test("refresh 记录 nextCursor；loadMore 携带它取下一页并合并去重", async () => {
  const feature = new CatalogFeature()
  const { ctx, calls } = makeCtx({
    "null": { threads: [row("a", 3000), row("b", 2000)], nextCursor: "c1" },
    "c1": { threads: [row("b", 2500), row("c", 1000)], nextCursor: null },
  })
  await feature.refreshThreadCatalog(ctx)
  expect(feature.state.threads.nextCursor).toBe("c1")
  expect(feature.state.threads.items.map(t => t.thread_id)).toEqual(["a", "b"])

  await feature.loadMoreThreads(ctx)
  // b 去重后按 updated_at 重排；新页为准
  expect(feature.state.threads.items.map(t => t.thread_id)).toEqual(["a", "b", "c"])
  expect(feature.state.threads.items.find(t => t.thread_id === "b")!.updated_at_ms).toBe(2500)
  expect(feature.state.threads.nextCursor).toBeNull()
  expect(calls).toEqual([null, "c1"])
})

test("nextCursor 为 null 时 loadMore 是 no-op；loadingMore 中重复触发被忽略", async () => {
  const feature = new CatalogFeature()
  const { ctx, calls } = makeCtx({
    "null": { threads: [row("a")], nextCursor: null },
  })
  await feature.refreshThreadCatalog(ctx)
  await feature.loadMoreThreads(ctx)
  expect(calls).toEqual([null])

  // 有 cursor 但加载中：第二个并发调用被吞
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const feature2 = new CatalogFeature()
  const { ctx: ctx2, calls: calls2 } = makeCtx({
    "null": { threads: [row("a")], nextCursor: "c1" },
    "c1": undefined as never,
  })
  await feature2.refreshThreadCatalog(ctx2)
  const slowCtx = {
    gateway: {
      async listThreads(cursor?: string) {
        calls2.push(cursor ?? null)
        await gate
        return { threads: [row("b")], nextCursor: null }
      },
    },
    publish: () => {},
  } as unknown as FeatureContext
  const p1 = feature2.loadMoreThreads(slowCtx)
  const p2 = feature2.loadMoreThreads(slowCtx)
  release()
  await Promise.all([p1, p2])
  expect(calls2).toEqual([null, "c1"])
  expect(feature2.state.threads.loadingMore).toBe(false)
})

test("refresh 重置游标与列表；loadMore 期间发生 refresh 时旧结果丢弃", async () => {
  const feature = new CatalogFeature()
  const { ctx } = makeCtx({
    "null": { threads: [row("a", 1000)], nextCursor: "c1" },
    "c1": { threads: [row("STALE", 9999)], nextCursor: null },
  })
  await feature.refreshThreadCatalog(ctx)

  // loadMore 慢响应途中，refresh 抬 epoch → 旧页结果不得写回
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const slow = {
    gateway: { async listThreads() { await gate; return { threads: [row("STALE", 9999)], nextCursor: null } } },
    publish: () => {},
  } as unknown as FeatureContext
  const p = feature.loadMoreThreads(slow)
  await feature.refreshThreadCatalog(ctx) // epoch 推进
  release()
  await p
  expect(feature.state.threads.items.map(t => t.thread_id)).toEqual(["a"])
})

test("loadMore 失败 → error 状态但已加载列表保留", async () => {
  const feature = new CatalogFeature()
  let failOnce = true
  const ctx = {
    gateway: {
      async listThreads(cursor?: string) {
        if (cursor === "c1" && failOnce) { failOnce = false; throw new Error("boom") }
        return { threads: [row("a")], nextCursor: "c1" }
      },
    },
    publish: () => {},
  } as unknown as FeatureContext
  await feature.refreshThreadCatalog(ctx)
  await feature.loadMoreThreads(ctx)
  expect(feature.state.threads.status).toBe("error")
  expect(feature.state.threads.items.map(t => t.thread_id)).toEqual(["a"])
  expect(feature.state.threads.loadingMore).toBe(false)
})

test("加载两页后 refresh：条目不塌回第一页、nextCursor 保留第二页的", async () => {
  const feature = new CatalogFeature()
  const { ctx } = makeCtx({
    "null": { threads: [row("a", 3000), row("b", 2000)], nextCursor: "c1" },
    "c1": { threads: [row("c", 1500), row("d", 1200)], nextCursor: "c2" },
  })
  await feature.refreshThreadCatalog(ctx)
  await feature.loadMoreThreads(ctx)
  expect(feature.state.threads.nextCursor).toBe("c2")

  // refresh 拉的第一页不含 c/d：合并保留已加载条目与游标
  await feature.refreshThreadCatalog(ctx)
  expect(feature.state.threads.items.map(t => t.thread_id)).toEqual(["a", "b", "c", "d"])
  expect(feature.state.threads.nextCursor).toBe("c2")
})

test("只加载过第一页时 refresh：nextCursor 取新值", async () => {
  const feature = new CatalogFeature()
  const { ctx } = makeCtx({
    "null": { threads: [row("a", 3000)], nextCursor: "c1" },
  })
  await feature.refreshThreadCatalog(ctx)
  expect(feature.state.threads.nextCursor).toBe("c1")
  await feature.refreshThreadCatalog(ctx)
  expect(feature.state.threads.nextCursor).toBe("c1")
})

test("refresh 返回新增会话：新条目最前、旧条目全部保留", async () => {
  const feature = new CatalogFeature()
  const pages: Record<string, { threads: ThreadSummary[]; nextCursor: string | null }> = {
    "null": { threads: [row("a", 3000), row("b", 2000)], nextCursor: "c1" },
    "c1": { threads: [row("c", 1500)], nextCursor: "c2" },
  }
  const { ctx } = makeCtx(pages)
  await feature.refreshThreadCatalog(ctx)
  await feature.loadMoreThreads(ctx)
  // 第二次 refresh 出现新会话 n（比所有都新）
  pages["null"] = { threads: [row("n", 9000), row("a", 3000), row("b", 2000)], nextCursor: "c1" }
  await feature.refreshThreadCatalog(ctx)
  const ids = feature.state.threads.items.map(t => t.thread_id)
  expect(ids[0]).toBe("n")
  expect(ids).toContain("c")
  expect(ids).toEqual(["n", "a", "b", "c"])
})

test("refresh 同 id 条目以新页为准（摘要更新）", async () => {
  const feature = new CatalogFeature()
  const pages: Record<string, { threads: ThreadSummary[]; nextCursor: string | null }> = {
    "null": { threads: [row("a", 3000)], nextCursor: "c1" },
    "c1": { threads: [row("c", 1500)], nextCursor: null },
  }
  const { ctx } = makeCtx(pages)
  await feature.refreshThreadCatalog(ctx)
  await feature.loadMoreThreads(ctx)
  const updated = { ...row("a", 5000), title: "a-renamed" }
  pages["null"] = { threads: [updated], nextCursor: "c1" }
  await feature.refreshThreadCatalog(ctx)
  const a = feature.state.threads.items.find(t => t.thread_id === "a")!
  expect(a.title).toBe("a-renamed")
  expect(a.updated_at_ms).toBe(5000)
  expect(feature.state.threads.items.map(t => t.thread_id)).toContain("c")
})

test("catalogFeature.reset 不清 threads 目录（工作区级数据不随会话切换重置）", async () => {
  const feature = new CatalogFeature()
  const { ctx } = makeCtx({
    "null": { threads: [row("a", 3000), row("b", 2000)], nextCursor: "c1" },
  })
  await feature.refreshThreadCatalog(ctx)
  feature.reset({}, ctx)
  expect(feature.state.threads.items.map(t => t.thread_id)).toEqual(["a", "b"])
  expect(feature.state.threads.nextCursor).toBe("c1")
  expect(feature.state.threads.loadingMore).toBe(false)
})
