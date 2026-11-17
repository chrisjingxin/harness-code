/**
 * 协作视图本地状态仓库（看板任务 + 双层团队知识库）：
 * 在后端 HC-212 Task/Knowledge 持久化接口上线前，按 (workspaceId, projectId) 维护本地状态并随成员列表自动映射，
 * 为原型稿 UI 提供真实可操作的认领、启动、完成、派发、编辑与版本号升级体验。
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import type { NavigationMember } from "@workbench/ui"

export type CollabTaskStatus = "open" | "claimed" | "running" | "done"
export type CollabTaskPrio = "high" | "mid" | "low"

export type CollabTask = {
  readonly id: string
  readonly projId: string
  readonly title: string
  readonly fromUserId: string
  readonly toUserId: string
  readonly status: CollabTaskStatus
  readonly prio: CollabTaskPrio
  readonly time: string
  readonly desc: string
  readonly sessionId: string | null
}

export type CollabKnowledgeScope = "workspace" | "project"

export type CollabKnowledge = {
  readonly id: string
  readonly scope: CollabKnowledgeScope
  readonly wsId: string
  readonly projId: string | null
  readonly title: string
  readonly authorUserId: string
  readonly version: string
  readonly updated: string
  readonly sum: string
  readonly body: string
}

export const TASK_STATUS_LABEL: Record<CollabTaskStatus, string> = {
  open: "待认领",
  claimed: "已认领",
  running: "进行中",
  done: "已完成",
}

export const TASK_PRIO_LABEL: Record<CollabTaskPrio, string> = {
  high: "高",
  mid: "中",
  low: "低",
}

const KNOWN_ROLES: Record<string, string> = {
  "张景新": "后端开发 · 组长",
  "沈北辰": "前端开发",
  "王大林": "后端开发",
  "明方鹏": "后端开发",
  "杨康": "后端开发",
  "冯学茗": "前端开发",
}

export function memberRoleLabel(member?: { readonly userName?: string | null; readonly orgName?: string | null } | null): string {
  if (!member) return "研发成员"
  return (member.userName && KNOWN_ROLES[member.userName]) || member.orgName || "研发成员"
}

function bumpVersion(ver: string): string {
  const m = String(ver || "v1.0").match(/^v?(\d+)(?:\.(\d+))?$/)
  if (!m) return "v1.1"
  const maj = Number.parseInt(m[1]!, 10) || 1
  const min = m[2] !== undefined ? Number.parseInt(m[2], 10) + 1 : 1
  return `v${maj}.${min}`
}

function seedTasksForProject(
  projectId: string,
  selfUserId: string,
  members: readonly NavigationMember[],
): CollabTask[] {
  const peer1 = members.find(m => m.userId !== selfUserId)?.userId ?? selfUserId
  const peer2 = members.filter(m => m.userId !== selfUserId)[1]?.userId ?? peer1
  const peer3 = members.filter(m => m.userId !== selfUserId)[2]?.userId ?? peer1

  return [
    {
      id: `t-${projectId}-0`,
      projId: projectId,
      title: "灰度白名单接口补 workspaceId",
      fromUserId: peer1,
      toUserId: selfUserId,
      status: "open",
      prio: "high",
      time: "今天 10:12",
      desc: "灰度白名单按 workspace 下发，但接口只返回了 ruleId。需要补 workspaceId 字段，前端才能按团队过滤白名单。",
      sessionId: null,
    },
    {
      id: `t-${projectId}-1`,
      projId: projectId,
      title: "支付方式列表接口缺 3 个字段",
      fromUserId: peer1,
      toUserId: peer2,
      status: "open",
      prio: "high",
      time: "今天 10:24",
      desc: "支付方式列表需要 enable、disabledReason、recommendScore 三个字段。现在前端只能整块灰掉，无法给出禁用原因。",
      sessionId: null,
    },
    {
      id: `t-${projectId}-2`,
      projId: projectId,
      title: "券金额精度校验补单元测试",
      fromUserId: peer1,
      toUserId: peer3,
      status: "open",
      prio: "mid",
      time: "今天 09:30",
      desc: "券金额从元改成整数分之后，缺少边界用例。补 0 元券、满减后负值、按比例取整三类用例。",
      sessionId: null,
    },
    {
      id: `t-${projectId}-3`,
      projId: projectId,
      title: "回调时序补充 refund 分支",
      fromUserId: selfUserId,
      toUserId: peer2,
      status: "running",
      prio: "high",
      time: "昨天 19:40",
      desc: "回调时序文档只画了支付成功分支，补上 refund 与 partial refund 两条路径，并标注幂等键位置。",
      sessionId: null,
    },
    {
      id: `t-${projectId}-4`,
      projId: projectId,
      title: "支付方式禁用态接口约定",
      fromUserId: peer3,
      toUserId: selfUserId,
      status: "claimed",
      prio: "mid",
      time: "昨天 16:05",
      desc: "禁用态需要后端明确返回 disabledReason 枚举，前端不再自己拼文案。约定枚举值：maintenance、unavailable、limit。",
      sessionId: null,
    },
    {
      id: `t-${projectId}-5`,
      projId: projectId,
      title: "导出任务失败重试上限配置化",
      fromUserId: selfUserId,
      toUserId: peer1,
      status: "done",
      prio: "low",
      time: "昨天 11:20",
      desc: "重试上限从硬编码 3 次改成配置项，默认仍为 3，超过进死信队列。",
      sessionId: null,
    },
  ]
}

function seedKnowledgeForScope(
  workspaceId: string,
  projectId: string,
  selfUserId: string,
  members: readonly NavigationMember[],
): CollabKnowledge[] {
  const peer1 = members.find(m => m.userId !== selfUserId)?.userId ?? selfUserId
  const peer2 = members.filter(m => m.userId !== selfUserId)[1]?.userId ?? peer1
  return [
    {
      id: `k-${workspaceId}-1`,
      scope: "workspace",
      wsId: workspaceId,
      projId: null,
      title: "金额字段整数分编码规约",
      authorUserId: selfUserId,
      version: "v1.4",
      updated: "2026-11-02",
      sum: "所有金额字段统一使用 int64 整数分存储与传输，禁止浮点与字符串。",
      body: "1. 存储与 Protobuf/JSON 传输一律采用 int64 单位「分」（Cents），字段命名固定以 Cents 结尾（如 settleCents、feeCents）。\n2. 严禁在网关或导出中间件里私自乘除 100；跨语言序列化保持原值透传。\n3. 仅前端 UI 展示层统一除以 100 并保留两位小数，舍入策略统一采用银行家舍入。",
    },
    {
      id: `k-${workspaceId}-2`,
      scope: "workspace",
      wsId: workspaceId,
      projId: null,
      title: "分布式幂等键设计规范",
      authorUserId: peer1,
      version: "v2.1",
      updated: "2026-10-19",
      sum: "幂等键按业务主键组合并加 {idem} hash tag，TTL 统一 24 小时，冲突时返回首次结果。",
      body: "1. Key 格式：pay:{idem}:<bizType>:<orderId>:<subNo>，必须携带 {idem} 保证 Redis 集群同 slot。\n2. 有效期：支付与退款链路统一 24h，查询类链路缩短为 2h。\n3. 重入语义：并发执行中返回 409 PROCESSING；已完成态幂等返回首次成功载荷，禁止二次触发下游网关。",
    },
    {
      id: `k-${workspaceId}-3`,
      scope: "workspace",
      wsId: workspaceId,
      projId: null,
      title: "交易域基础术语表",
      authorUserId: peer2,
      version: "v1.0",
      updated: "2026-09-08",
      sum: "统一支付、结算、对账、退款四个子域的中英文命名，避免前后端字段各写一套。",
      body: "• 收单支付（Acquiring / Pay）：tradeNo（交易号）、payChannel（支付通道）、disabledReason（禁用枚举）。\n• 清分结算（Settlement）：settleCents、feeCents、merchantId。\n• 对账差异（Reconciliation）：diffType、compensateTaskId、checkpoint。\n• 退款（Refund）：refundNo、PARTIAL_REFUNDED、refundGateway。",
    },
    {
      id: `k-${projectId}-adr`,
      scope: "project",
      wsId: workspaceId,
      projId: projectId,
      title: "项目状态机与回调幂等 ADR",
      authorUserId: selfUserId,
      version: "v3.0",
      updated: "2026-11-12",
      sum: "拆单或核心变更后状态收敛为 PAID / REFUNDING / PARTIAL_REFUNDED 三态，回调入口统一走幂等闸门。",
      body: "【背景】高并发异步回调与补偿任务存在并发到达的风险。\n【决策】\n- 状态迁移仅允许 PAID → REFUNDING / PARTIAL_REFUNDED，PARTIAL_REFUNDED → REFUNDING。\n- 回调入口与定时补偿必须共用同一套 idempotent(orderId, refundNo) 闸门，补偿任务不得跳过状态校验直接改库。",
    },
  ]
}

const STORAGE_PREFIX = "hc221.collab."

type PersistedCollab = {
  tasksByProj: Record<string, CollabTask[]>
  knowledgeByWs: Record<string, CollabKnowledge[]>
}

function loadPersisted(): PersistedCollab {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}v1`)
    if (!raw) return { tasksByProj: {}, knowledgeByWs: {} }
    const parsed = JSON.parse(raw) as Partial<PersistedCollab>
    return {
      tasksByProj: parsed.tasksByProj ?? {},
      knowledgeByWs: parsed.knowledgeByWs ?? {},
    }
  } catch {
    return { tasksByProj: {}, knowledgeByWs: {} }
  }
}

function savePersisted(data: PersistedCollab): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}v1`, JSON.stringify(data))
  } catch { /* 忽略配额异常 */ }
}

export function useCollabStore(
  workspaceId: string | null,
  projectId: string | null,
  selfUserId: string,
  members: readonly NavigationMember[],
) {
  const [store, setStore] = useState<PersistedCollab>(() => loadPersisted())

  useEffect(() => {
    savePersisted(store)
  }, [store])

  const projectTasks = useMemo(() => {
    if (!projectId) return [] as CollabTask[]
    const saved = store.tasksByProj[projectId]
    if (saved) return saved
    return seedTasksForProject(projectId, selfUserId, members)
  }, [store.tasksByProj, projectId, selfUserId, members])

  const workspaceKnowledge = useMemo(() => {
    if (!workspaceId || !projectId) return [] as CollabKnowledge[]
    const saved = store.knowledgeByWs[workspaceId]
    const list = saved ?? seedKnowledgeForScope(workspaceId, projectId, selfUserId, members)
    const hasProjAdr = list.some(k => k.scope === "project" && k.projId === projectId)
    if (!hasProjAdr) {
      return [
        ...list,
        ...seedKnowledgeForScope(workspaceId, projectId, selfUserId, members).filter(k => k.scope === "project"),
      ]
    }
    return list
  }, [store.knowledgeByWs, workspaceId, projectId, selfUserId, members])

  const visibleKnowledge = useMemo(() => {
    return workspaceKnowledge.filter(k =>
      (k.scope === "workspace" && k.wsId === workspaceId)
      || (k.scope === "project" && k.projId === projectId),
    )
  }, [workspaceKnowledge, workspaceId, projectId])

  const wsKnowledgeCount = useMemo(
    () => workspaceKnowledge.filter(k => k.scope === "workspace" && k.wsId === workspaceId).length,
    [workspaceKnowledge, workspaceId],
  )

  const projKnowledgeCount = useMemo(
    () => workspaceKnowledge.filter(k => k.scope === "project" && k.projId === projectId).length,
    [workspaceKnowledge, projectId],
  )

  const todoCount = useMemo(
    () => projectTasks.filter(t => t.toUserId === selfUserId && (t.status === "open" || t.status === "claimed")).length,
    [projectTasks, selfUserId],
  )

  const mutateTasks = useCallback((updater: (list: CollabTask[]) => CollabTask[]) => {
    if (!projectId) return
    setStore(prev => {
      const current = prev.tasksByProj[projectId] ?? seedTasksForProject(projectId, selfUserId, members)
      return {
        ...prev,
        tasksByProj: { ...prev.tasksByProj, [projectId]: updater(current) },
      }
    })
  }, [projectId, selfUserId, members])

  const claimTask = useCallback((taskId: string) => {
    mutateTasks(list => list.map(t => (t.id === taskId ? { ...t, status: "claimed" } : t)))
  }, [mutateTasks])

  const startTask = useCallback((taskId: string, sessionId: string) => {
    mutateTasks(list => list.map(t => (t.id === taskId ? { ...t, status: "running", sessionId } : t)))
  }, [mutateTasks])

  const finishTask = useCallback((taskId: string) => {
    mutateTasks(list => list.map(t => (t.id === taskId ? { ...t, status: "done" } : t)))
  }, [mutateTasks])

  const dispatchTask = useCallback((input: {
    title: string
    toUserId: string
    desc: string
    prio?: CollabTaskPrio
  }): CollabTask | null => {
    if (!projectId) return null
    const task: CollabTask = {
      id: `t-${Date.now()}`,
      projId: projectId,
      title: input.title,
      fromUserId: selfUserId,
      toUserId: input.toUserId,
      status: "open",
      prio: input.prio ?? "high",
      time: "刚刚",
      desc: input.desc || "从协同会话发起并派发此任务。",
      sessionId: null,
    }
    mutateTasks(list => [task, ...list])
    return task
  }, [projectId, selfUserId, mutateTasks])

  const createKnowledge = useCallback((input: {
    title: string
    sum: string
    body: string
    scope: CollabKnowledgeScope
  }): CollabKnowledge | null => {
    if (!workspaceId || !projectId) return null
    const item: CollabKnowledge = {
      id: `k-${Date.now()}`,
      scope: input.scope,
      wsId: workspaceId,
      projId: input.scope === "project" ? projectId : null,
      title: input.title,
      authorUserId: selfUserId,
      version: "v1.0",
      updated: "刚刚",
      sum: input.sum || input.title,
      body: input.body || input.sum || input.title,
    }
    setStore(prev => {
      const base = prev.knowledgeByWs[workspaceId] ?? seedKnowledgeForScope(workspaceId, projectId, selfUserId, members)
      return {
        ...prev,
        knowledgeByWs: { ...prev.knowledgeByWs, [workspaceId]: [item, ...base] },
      }
    })
    return item
  }, [workspaceId, projectId, selfUserId, members])

  const updateKnowledge = useCallback((id: string, sum: string, body: string): CollabKnowledge | null => {
    if (!workspaceId || !projectId) return null
    let updatedItem: CollabKnowledge | null = null
    setStore(prev => {
      const base = prev.knowledgeByWs[workspaceId] ?? seedKnowledgeForScope(workspaceId, projectId, selfUserId, members)
      const next = base.map(k => {
        if (k.id !== id) return k
        updatedItem = {
          ...k,
          sum: sum.trim() || k.sum,
          body: body.trim() || k.body,
          version: bumpVersion(k.version),
          updated: "刚刚",
        }
        return updatedItem
      })
      return { ...prev, knowledgeByWs: { ...prev.knowledgeByWs, [workspaceId]: next } }
    })
    return updatedItem
  }, [workspaceId, projectId, selfUserId, members])

  return {
    tasks: projectTasks,
    knowledge: visibleKnowledge,
    allKnowledge: workspaceKnowledge,
    todoCount,
    wsKnowledgeCount,
    projKnowledgeCount,
    claimTask,
    startTask,
    finishTask,
    dispatchTask,
    createKnowledge,
    updateKnowledge,
  }
}
