/** 首次建图的共享 Interactive 状态与通知闭环。 */
import { expect, test } from "bun:test"

import { Capability, type CodeIndexApplyParams, type CodeIndexSnapshot } from "@za38/protocol"
import { selectCodeIndexView } from "../../src/interactive/selectors"
import { flush, makeHarness, notices, runtime } from "./harness"

const absent: CodeIndexSnapshot = {
  revision: 0,
  generation: 0,
  engine_version: "1.1.6",
  data_directory: ".harness-index",
  runtime_status: "ready",
  index_status: "absent",
  query_status: "stopped",
  watcher_status: "stopped",
  job: null,
  stats: null,
  error: null,
}

test("空参命令先刷新 revision 再受理 ensure，进度不阻塞普通 Run", async () => {
  const running: CodeIndexSnapshot = {
    ...absent,
    revision: 1,
    job: { id: "job-1", action: "initialize", status: "running", phase: "indexing", completed: 2 },
  }
  const harness = makeHarness({
    capabilities: [...(runtime.capabilities ?? []), Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => absent,
    codeIndexApplyImpl: async params => {
      expect(params).toEqual({ action: "ensure", expected_revision: 0 })
      return running
    },
  })
  try {
    const outcome = await harness.controller.dispatch({ type: "input.submit", value: "/code-index" })
    expect(outcome.status).toBe("accepted")
    expect(harness.calls).toEqual(expect.arrayContaining(["code_index.status", "code_index.apply(ensure,0)"]))
    expect(harness.controller.getSnapshot().activity.kind).toBe("home")
    expect(notices(harness.controller.getSnapshot())).toBe("")
    expect(selectCodeIndexView(harness.controller.getSnapshot())?.body).toBe("代码索引 · 建立中\n已处理 2 项")

    const submit = await harness.controller.dispatch({ type: "input.submit", value: "继续普通任务" })
    expect(submit.status).toBe("accepted")
    expect(harness.calls).toContain("run.start")
  } finally {
    await harness.controller.close()
  }
})

test("changed 通知只接受较新 revision 并原地收敛到 ready 统计", async () => {
  const harness = makeHarness({
    capabilities: [...(runtime.capabilities ?? []), Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => absent,
    codeIndexApplyImpl: async () => ({ ...absent, revision: 1, job: { id: "job-1", action: "initialize", status: "running", phase: "indexing" } }),
  })
  try {
    await harness.controller.dispatch({ type: "input.submit", value: "/code-index" })
    harness.port.emitCodeIndexChanged({
      ...absent,
      revision: 3,
      generation: 1,
      index_status: "ready",
      query_status: "ready",
      watcher_status: "ready",
      job: { id: "job-1", action: "initialize", status: "succeeded", phase: "starting_query" },
      stats: { files: 4, symbols: 12, relationships: 8, db_bytes: 100, wal_bytes: 0 },
    })
    harness.port.emitCodeIndexChanged({ ...absent, revision: 2 })
    await flush()
    expect(harness.controller.getSnapshot().codeIndex?.revision).toBe(3)
    expect(selectCodeIndexView(harness.controller.getSnapshot())?.body)
      .toBe("代码索引 · 已就绪\n4 个文件 · 12 个符号 · 8 条关系\n查询就绪 · 自动同步就绪")
  } finally {
    await harness.controller.close()
  }
})

test("没有 manage capability 时 status 可读但首建被本地拒绝", async () => {
  const harness = makeHarness({ capabilities: [Capability.CODE_INDEX_READ] })
  try {
    const outcome = await harness.controller.dispatch({ type: "input.submit", value: "/code-index" })
    expect(outcome).toEqual({ status: "rejected", code: "capability-missing", message: "当前连接不能建立代码索引。" })
    expect(harness.calls).not.toContainEqual(expect.stringContaining("code_index.apply"))
  } finally {
    await harness.controller.close()
  }
})

test("rebuild 和 cancel 都刷新 revision 并发送完整动作参数", async () => {
  const running: CodeIndexSnapshot = {
    ...absent,
    revision: 7,
    index_status: "ready",
    job: { id: "job-current", action: "sync", status: "running", phase: "indexing" },
  }
  const requests: CodeIndexApplyParams[] = []
  const harness = makeHarness({
    capabilities: [...(runtime.capabilities ?? []), Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => running,
    codeIndexApplyImpl: async params => {
      requests.push(params)
      return { ...running, revision: running.revision + requests.length }
    },
  })
  try {
    expect((await harness.controller.dispatch({ type: "input.submit", value: "/code-index rebuild" })).status).toBe("accepted")
    expect((await harness.controller.dispatch({ type: "input.submit", value: "/code-index cancel" })).status).toBe("accepted")
    expect(requests).toEqual([
      { action: "rebuild", expected_revision: 7 },
      { action: "cancel", expected_revision: 7, job_id: "job-current" },
    ])
    expect(harness.calls.filter(call => call === "code_index.status")).toHaveLength(2)
  } finally {
    await harness.controller.close()
  }
})

test("remove 只在共享确认完成后发送 confirmed true", async () => {
  const ready: CodeIndexSnapshot = { ...absent, revision: 5, generation: 1, index_status: "ready", query_status: "ready", watcher_status: "ready" }
  const requests: CodeIndexApplyParams[] = []
  const harness = makeHarness({
    capabilities: [...(runtime.capabilities ?? []), Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => ready,
    codeIndexApplyImpl: async params => {
      requests.push(params)
      return { ...absent, revision: 6 }
    },
  })
  try {
    const requested = await harness.controller.dispatch({ type: "input.submit", value: "/code-index remove" })
    expect(requested.status).toBe("accepted")
    expect(harness.controller.getSnapshot().confirmation).toMatchObject({
      confirmationId: "code-index-remove",
      title: "删除代码索引？",
    })
    expect(requests).toEqual([])

    await harness.controller.dispatch({
      type: "confirmation.resolve",
      confirmationId: "code-index-remove",
      confirmed: true,
    })
    expect(requests).toEqual([{ action: "remove", expected_revision: 5, confirmed: true }])
    expect(harness.controller.getSnapshot().confirmation).toBeNull()
  } finally {
    await harness.controller.close()
  }
})

test("未知子命令显示完整 usage，watcher 降级提示手工更新", async () => {
  const harness = makeHarness({
    capabilities: [...(runtime.capabilities ?? []), Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
  })
  try {
    await harness.controller.dispatch({ type: "input.submit", value: "/code-index wat" })
    expect(notices(harness.controller.getSnapshot())).toContain("/code-index [status|rebuild|cancel|remove]")
    harness.port.emitCodeIndexChanged({
      ...absent,
      revision: 4,
      generation: 1,
      index_status: "ready",
      query_status: "ready",
      watcher_status: "degraded",
    })
    await flush()
    expect(selectCodeIndexView(harness.controller.getSnapshot())?.body).toContain("可能已过期；执行 /code-index 手工更新")
  } finally {
    await harness.controller.close()
  }
})

test("写操作优先显示 Host 提供的稳定恢复文案", async () => {
  const harness = makeHarness({
    capabilities: [...(runtime.capabilities ?? []), Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => ({ ...absent, revision: 9, index_status: "ready" }),
    codeIndexApplyImpl: async () => {
      throw Object.assign(new Error("CODE_INDEX_RUN_ACTIVE"), {
        data: { code: "CODE_INDEX_RUN_ACTIVE", retryable: true, details: { message: "当前有对话正在使用代码索引。", recovery: "等待该对话结束后重试。" } },
      })
    },
  })
  try {
    const outcome = await harness.controller.dispatch({ type: "input.submit", value: "/code-index rebuild" })
    expect(outcome).toEqual({ status: "rejected", code: "agent-error", message: "当前有对话正在使用代码索引。\n等待该对话结束后重试。" })
  } finally {
    await harness.controller.close()
  }
})
