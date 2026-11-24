/**
 * HC-246 `workbench://` Deep-Link 白名单解析与 `DeepLinkBroker` 单实例挂起生命周期单测：
 * 覆盖白名单路由放行、非法协议/路径/参数/UUID/超长/控制字符安全拦截、冷热启动参数提取，
 * 以及未登录暂存、登录后投递与登出清空防跨账号泄漏行为。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { WorkbenchDeepLinkEvent } from "../src/shared/index.ts"
import {
  DeepLinkBroker,
  extractWorkbenchDeepLinkFromArgv,
  parseWorkbenchDeepLink,
} from "../src/main/deep-link.ts"
import { resolveDeepLinkNavigation } from "../src/renderer/features/inbox/inbox-model.ts"

const WS_ID = "aaaa1111-1111-4111-8111-111111111111"
const PROJ_ID = "bbbb2222-2222-4222-8222-222222222222"
const TASK_ID = "cccc3333-3333-4333-8333-333333333333"

test("parseWorkbenchDeepLink 仅放行白名单路由与严格小写 UUID 参数", () => {
  assert.deepEqual(parseWorkbenchDeepLink("workbench://open/inbox"), {
    ok: true,
    target: { kind: "inbox" },
  })

  const taskRes = parseWorkbenchDeepLink(
    `workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}&taskId=${TASK_ID}`,
  )
  assert.deepEqual(taskRes, {
    ok: true,
    target: { kind: "task", workspaceId: WS_ID, projectId: PROJ_ID, taskId: TASK_ID },
  })

  // 查询参数顺序不同也允许通过
  const reordered = parseWorkbenchDeepLink(
    `workbench://open/task?taskId=${TASK_ID}&workspaceId=${WS_ID}&projectId=${PROJ_ID}`,
  )
  assert.equal(reordered.ok, true)
})

test("parseWorkbenchDeepLink 严格拒绝越界协议、未知路径、多余参数、非法 UUID 与超长链接", () => {
  const rejected = [
    "",
    "   ",
    "https://open/inbox",
    "workbench://exec/run?cmd=rm",
    "workbench://user@open/inbox",
    "workbench://open:8443/inbox",
    "workbench://open/inbox#section",
    "workbench://open/inbox?extra=1",
    "workbench://open/settings",
    `workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}`,
    `workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}&taskId=${TASK_ID}&extra=foo`,
    `workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}&taskId=${TASK_ID}&taskId=${TASK_ID}`,
    `workbench://open/task?workspaceId=${WS_ID.toUpperCase()}&projectId=${PROJ_ID}&taskId=${TASK_ID}`,
    `workbench://open/task?workspaceId=not-a-uuid&projectId=${PROJ_ID}&taskId=${TASK_ID}`,
    `workbench://open/inbox\n`,
    `workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}&taskId=${TASK_ID}&pad=${"a".repeat(500)}`,
  ]
  for (const input of rejected) {
    const res = parseWorkbenchDeepLink(input)
    assert.equal(res.ok, false, `预期拒绝非法链接: ${JSON.stringify(input)}`)
    if (!res.ok) assert.equal(res.message, "无效的跳转链接。")
  }
})

test("extractWorkbenchDeepLinkFromArgv 从启动或二次唤醒参数列表准确提取唯一深链接", () => {
  assert.equal(
    extractWorkbenchDeepLinkFromArgv(["/Applications/Workbench.app", "--allow-file", "workbench://open/inbox"]),
    "workbench://open/inbox",
  )
  assert.equal(
    extractWorkbenchDeepLinkFromArgv(["node", "--inspect", "C:\\app.exe"]),
    null,
  )
})

test("DeepLinkBroker 实现未登录挂起、登录后投递、登出清空及非法链接提示", () => {
  const warnings: string[] = []
  const delivered: WorkbenchDeepLinkEvent[] = []
  const broker = new DeepLinkBroker(msg => warnings.push(msg))
  broker.attachDeliver(event => {
    delivered.push(event)
    return true
  })

  // 1. 未登录且渲染层尚未消费前收到合法深链接 → 必须暂存而非提前清空
  broker.receiveRawUrl(`workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}&taskId=${TASK_ID}`)
  assert.equal(delivered.length, 0)
  assert.equal(broker.consumePending(), null) // 标记 rendererReady，但尚未 signedIn，继续保留挂起目标
  assert.ok(broker.peekPending()?.ok)

  // 2. 登录成功后自动投递一次并清空挂起槽
  broker.setSignedIn(true)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], {
    ok: true,
    target: { kind: "task", workspaceId: WS_ID, projectId: PROJ_ID, taskId: TASK_ID },
  })
  assert.equal(broker.peekPending(), null)

  // 3. 热启动再收新链接 → 立即直达投递
  broker.receiveRawUrl("workbench://open/inbox")
  assert.equal(delivered.length, 2)
  assert.deepEqual(delivered[1], { ok: true, target: { kind: "inbox" } })

  // 4. 挂起期间登出/切号 → 必须清空防跨账号泄漏
  broker.markRendererNotReady()
  broker.receiveRawUrl("workbench://open/inbox")
  assert.ok(broker.peekPending()?.ok)
  broker.setSignedIn(false)
  assert.equal(broker.peekPending(), null)

  // 5. 非法链接记录告警并给出安全错误事件，绝不产出合法路由
  broker.receiveRawUrl("workbench://evil/exec")
  assert.equal(warnings.length, 1)
  const errEvent = broker.consumePending()
  assert.deepEqual(errEvent, { ok: false, message: "无效的跳转链接。" })
})

test("DeepLinkBroker 支持关窗重开与页面重载后的单次安全投递", () => {
  const deliveredWindow1: WorkbenchDeepLinkEvent[] = []
  const deliveredWindow2: WorkbenchDeepLinkEvent[] = []
  const broker = new DeepLinkBroker()

  broker.attachDeliver(event => {
    deliveredWindow1.push(event)
    return true
  })
  broker.setSignedIn(true)
  assert.equal(broker.consumePending(), null)

  // 1. 页面触发导航未就绪期间收到深链接 → 挂起至新渲染层 consumePending()
  broker.markRendererNotReady()
  broker.receiveRawUrl("workbench://open/inbox")
  assert.equal(deliveredWindow1.length, 0)
  assert.deepEqual(broker.consumePending(), { ok: true, target: { kind: "inbox" } })
  assert.equal(broker.peekPending(), null)

  // 2. macOS 关窗（detachDeliver）后通过 open-url 重建新窗口 → 重挂 deliver 并由新窗口消费一次
  broker.detachDeliver()
  broker.receiveRawUrl(`workbench://open/task?workspaceId=${WS_ID}&projectId=${PROJ_ID}&taskId=${TASK_ID}`)
  assert.equal(deliveredWindow1.length, 0)
  assert.ok(broker.peekPending()?.ok)

  broker.attachDeliver(event => {
    deliveredWindow2.push(event)
    return true
  })
  assert.deepEqual(broker.consumePending(), {
    ok: true,
    target: { kind: "task", workspaceId: WS_ID, projectId: PROJ_ID, taskId: TASK_ID },
  })
  assert.equal(broker.peekPending(), null)
  assert.equal(deliveredWindow2.length, 0)
})

test("resolveDeepLinkNavigation 拦截离线与跨团队越权目标并产出只读定位意图", () => {
  assert.deepEqual(
    resolveDeepLinkNavigation({
      target: { kind: "inbox" },
      offline: false,
      workspaceIds: [WS_ID],
    }),
    { action: "open_inbox", shouldRefreshInbox: true },
  )
  assert.deepEqual(
    resolveDeepLinkNavigation({
      target: { kind: "inbox" },
      offline: true,
      workspaceIds: [],
    }),
    { action: "open_inbox", shouldRefreshInbox: false },
  )

  const taskTarget = { kind: "task", workspaceId: WS_ID, projectId: PROJ_ID, taskId: TASK_ID } as const
  assert.deepEqual(
    resolveDeepLinkNavigation({
      target: taskTarget,
      offline: true,
      workspaceIds: [WS_ID],
    }),
    { action: "deny", message: "当前处于离线状态，重连协作服务后可查看该任务。" },
  )
  assert.deepEqual(
    resolveDeepLinkNavigation({
      target: taskTarget,
      offline: false,
      workspaceIds: ["99999999-9999-4999-8999-999999999999"],
    }),
    { action: "deny", message: "当前账号无权访问该任务或已不在对应项目。" },
  )
  assert.deepEqual(
    resolveDeepLinkNavigation({
      target: taskTarget,
      offline: false,
      workspaceIds: [WS_ID],
    }),
    {
      action: "reveal_task",
      workspaceId: WS_ID,
      projectId: PROJ_ID,
      taskId: TASK_ID,
    },
  )
})
