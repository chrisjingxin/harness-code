/**
 * `LocalUiClient`：ACP 入口的进程内 `WebUiClient`，把控制器的本地快照
 * 直接翻译成 8 个界面分片，不经过 socket 序列化。
 *
 * 与 `web/ui-client.ts` 的区别：
 * - 无 IO：快照按引用拿，不 JSON 拷贝（interaction 里的 `deadlineAtMs:
 *   Infinity` 经 `sameSlice` 的 JSON.stringify 会变成 null —— 这里不做
 *   合并 diff，每次发布全量新引用，规避 §5.2 记录的序列化丢精度问题）；
 * - 文件树/Git/trace 是固定缺口值（GAP-11/12/19），不连后端 workspace
 *   explorer；
 * - `close()` 只解订阅，不关控制器与网关（由 `session.close()` 统一收尾）。
 */

import type { InteractiveController, InteractiveIntent, IntentOutcome } from "../../interactive/types"
import type { PresentationState } from "../../presentation-coordinator/state"
import { buildWebUiState } from "../../presentation-coordinator/web-ui-gateway"
import type { WebUiClient } from "../../web/ui-client"
import type { WebUiState } from "../../presentation-coordinator/contracts"
import type { TraceLoadResult, TraceSpanEvent } from "../../presentation-coordinator/contracts/trace"
import type { WorkspaceIntent, WorkspaceOutcome, WorkspaceSnapshot } from "../../workspace/types"

const WORKSPACE_UNAVAILABLE: WorkspaceSnapshot = {
  tree: { status: "error", rows: [], selectedPath: null, limited: false, message: "当前入口暂不支持浏览工作区文件（GAP-11）" },
  preview: { status: "idle" },
}

const GIT_UNAVAILABLE = { busy: false, repository: null, diff: null, result: null, error: "当前入口暂不支持 Git（GAP-12）" } as const

const HANDOFF: PresentationState = { phase: "web-active", handoffId: "acp-local" }

export function createLocalUiClient(options: { controller: InteractiveController }): WebUiClient {
  const controller = options.controller
  const listeners = new Set<(state: WebUiState) => void>()
  let closed = false
  let lastSnapshot: unknown = null
  let lastState: WebUiState | null = null

  const compute = (): WebUiState => {
    const snapshot = controller.getSnapshot()
    // 同一快照引用只算一次：分片是纯函数，缓存键就是引用。
    if (snapshot === lastSnapshot && lastState) return lastState
    const state = buildWebUiState(snapshot, WORKSPACE_UNAVAILABLE)
    lastSnapshot = snapshot
    lastState = {
      ...state,
      runtime: { ...state.runtime, git: { ...GIT_UNAVAILABLE } },
    }
    return lastState
  }

  const unsubscribe = controller.subscribe(() => {
    const state = compute()
    for (const listener of [...listeners]) listener(state)
  })

  return {
    getState: () => compute(),
    getHandoffState: () => HANDOFF,
    subscribeState(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    subscribeHandoff(_listener) {
      return () => {}
    },
    async submitIntent(intent: InteractiveIntent): Promise<IntentOutcome> {
      try {
        return await controller.dispatch(intent)
      } catch (error) {
        return { status: "rejected", code: "agent-error", message: error instanceof Error ? error.message : String(error) }
      }
    },
    workspaceIntent(_intent: WorkspaceIntent): Promise<WorkspaceOutcome> {
      return Promise.resolve({
        status: "rejected",
        code: "io-error",
        message: "当前入口暂不支持浏览工作区文件（GAP-11）",
      })
    },
    loadThreadTrace(_threadId: string): Promise<TraceLoadResult> {
      return Promise.resolve({ spans: [], hasAnyTrace: false, error: null })
    },
    getLiveTrace: () => [],
    subscribeTrace(_listener) {
      return () => {}
    },
    ready(): void {},
    returnToTui(): void {},
    requestExit(): void {},
    close(): void {
      if (closed) return
      closed = true
      unsubscribe()
      listeners.clear()
    },
  }
}
