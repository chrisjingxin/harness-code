/** WebApp：active=false 时显示接管只读提示；active=true 时 composer 可用。 */
/** @jsxImportSource react */

import { afterAll, describe, expect, test } from "bun:test"
import { act } from "react"

import { WebApp } from "../../../src/web/presentation/web-app"
import type { WebAdapterSnapshot, WebIntent, WebInteractiveAdapter } from "../../../src/web/application/adapter"
import { makeInteractive, makeRuntime, makeSnapshot } from "./fixtures"
import { registerTestDom, render, setControlledValue, type RenderHandle } from "./render"

const unregisterTestDom = registerTestDom()
afterAll(() => unregisterTestDom())


type AdapterHarness = WebInteractiveAdapter & {
  emit(next: WebAdapterSnapshot): void
  intentLog: WebIntent[]
  closeCount: number
  listeners: Set<(snapshot: WebAdapterSnapshot) => void>
  storedSnapshot: WebAdapterSnapshot
}

function createFakeAdapter(initial: WebAdapterSnapshot): AdapterHarness {
  const listeners = new Set<(snapshot: WebAdapterSnapshot) => void>()
  const harness: AdapterHarness = {
    storedSnapshot: initial,
    intentLog: [],
    closeCount: 0,
    listeners,
    getSnapshot() { return this.storedSnapshot },
    subscribe(listener) {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
    async dispatch(intent) {
      this.intentLog.push(intent)
    },
    async close() {
      this.closeCount += 1
    },
    emit(next) {
      this.storedSnapshot = next
      for (const listener of [...this.listeners]) listener(next)
    },
  }
  return harness
}

function mountWebApp(active: boolean, snapshot: WebAdapterSnapshot): { adapter: AdapterHarness; handle: RenderHandle } {
  const adapter = createFakeAdapter(snapshot)
  const handle = render(<WebApp adapter={adapter} active={active} />)
  return { adapter, handle }
}

describe("WebApp", () => {
  test("代码索引删除使用共享确认文案并回传确认结果", async () => {
    const confirmation = {
      confirmationId: "code-index-remove",
      title: "删除代码索引？",
      message: "这会删除当前工作区的本地代码索引数据；源码不会被修改。",
      confirmLabel: "删除索引",
      cancelLabel: "保留索引",
    }
    const { adapter, handle } = mountWebApp(true, makeSnapshot({
      interactive: makeInteractive({ confirmation }),
    }))
    try {
      const dialog = handle.container.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain("删除代码索引？")
      const confirm = handle.container.querySelector<HTMLButtonElement>('button[aria-label="删除索引"]')
      expect(confirm).not.toBeNull()
      await act(async () => { confirm?.click() })
      expect(adapter.intentLog).toContainEqual({
        type: "confirmation-resolve",
        confirmationId: "code-index-remove",
        confirmed: true,
      })
    } finally {
      handle.unmount()
    }
  })

  test("代码索引查看浮层只显示中性状态文案", () => {
    const { handle } = mountWebApp(true, makeSnapshot({
      inspectOverlay: {
        visible: true,
        kind: "code-index",
        title: "代码索引",
        body: "代码索引 · 未建立",
      },
    }))
    try {
      const dialog = handle.container.querySelector('[role="dialog"]')
      expect(dialog?.getAttribute("aria-label")).toBe("代码索引")
      expect(dialog?.textContent).toContain("代码索引 · 未建立")
      expect(dialog?.textContent).not.toContain("CodeGraph")
      expect(dialog?.textContent).not.toContain("实验")
    } finally {
      handle.unmount()
    }
  })

  test("代码索引进度浮层显示阶段与数量且不含百分比", () => {
    const { handle } = mountWebApp(true, makeSnapshot({
      inspectOverlay: {
        visible: true,
        kind: "code-index",
        title: "代码索引",
        body: "代码索引 · 解析中\n已处理 3 / 5 项",
      },
    }))
    try {
      const dialog = handle.container.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain("解析中")
      expect(dialog?.textContent).toContain("已处理 3 / 5 项")
      expect(dialog?.textContent).not.toContain("%")
      expect(dialog?.textContent).not.toContain("CodeGraph")
    } finally {
      handle.unmount()
    }
  })

  test("active=false 时显示「正在接管」只读提示，且 composer disabled", () => {
    const { adapter, handle } = mountWebApp(false, makeSnapshot())
    try {
      const opening = handle.container.querySelector(".web-shell")
      expect(opening?.getAttribute("data-active")).toBe("false")
      expect(opening?.getAttribute("data-theme")).toBe("light")
      const handoff = handle.container.querySelector(".handoff-banner")
      expect(handoff?.textContent).toContain("等待 CLI 确认控制权")
      expect(handle.container.querySelector(".meta-chip-run")).toBeNull()
      const composer = handle.container.querySelector<HTMLTextAreaElement>(".composer-textarea")
      expect(composer?.disabled).toBe(true)
      expect(adapter.intentLog.length).toBe(0)
    } finally {
      handle.unmount()
    }
  })

  test("active=true 时「正在接管」提示消失，composer 接收用户输入", () => {
    const { handle } = mountWebApp(true, makeSnapshot({ draft: "hello" }))
    try {
      const opening = handle.container.querySelector(".web-shell")
      expect(opening?.getAttribute("data-active")).toBe("true")
      expect(handle.container.querySelector(".handoff-banner")).toBeNull()
      const composer = handle.container.querySelector<HTMLTextAreaElement>(".composer-textarea")
      expect(composer?.disabled).toBe(false)
      expect(composer?.value).toBe("hello")
    } finally {
      handle.unmount()
    }
  })

  test("Run 状态不再渲染顶栏活动状态入口", () => {
    const { handle } = mountWebApp(true, makeSnapshot({
      interactive: makeInteractive({ activity: { kind: "running" }, activeRun: { threadId: "t1", runId: "r1" } }),
    }))
    try {
      expect(handle.container.querySelector(".meta-chip-run")).toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("顶栏按设计稿显示工作区路径，模型和审批保留 Composer rail", () => {
    const { handle } = mountWebApp(true, makeSnapshot())
    try {
      expect(handle.container.querySelector(".brand-name")?.textContent).toBe("Harness Code")
      const main = handle.container.querySelector(".topbar-main")
      expect(main?.querySelector(".topbar-project")?.textContent).toContain("workspace")
      expect(main?.querySelector(".topbar-model") === null).toBe(true)
      expect(main?.querySelector(".topbar-approval-mode") === null).toBe(true)
      expect(main?.querySelector(".topbar-meta") === null).toBe(true)
      expect(handle.container.querySelector(".topbar-branch")).toBeNull()
      expect(handle.container.querySelector(".meta-chip-run")).toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test.each([
    ["/projects/harness-code", "/projects/harness-code", "harness-code"],
    ["/projects/harness-code/packages/cli", "/projects/harness-code/", "harness-code / packages/cli"],
    ["/projects/harness-code-other/cli", "/projects/harness-code", "cli"],
    ["/projects/notes/", null, "notes"],
    ["C:\\Projects\\harness-code\\packages\\cli\\", "C:\\Projects\\harness-code", "harness-code / packages/cli"],
    ["c:/Projects/harness-code/packages/cli", "C:/Projects/harness-code", "harness-code / packages/cli"],
  ])("顶部项目标识：%s", (workspace, root, expected) => {
    const { handle } = mountWebApp(true, makeSnapshot({ interactive: makeInteractive({
      runtime: makeRuntime({ workspace, gitWorkspace: root ? { kind: "branch", root, branch: "main" } : { kind: "not-repository" } }),
    }) }))
    try {
      const project = handle.container.querySelector(".topbar-project")
      expect(project?.textContent).toBe(expected)
      expect(project?.getAttribute("title")).toBe(workspace)
    } finally { handle.unmount() }
  })

  test("detached HEAD 仍显示项目与子目录，Git 信息不可用时显示目录名", () => {
    const runtime = makeRuntime({ workspace: "/projects/demo/src", gitWorkspace: { kind: "detached", root: "/projects/demo", shortSha: "abc1234" } })
    const { adapter, handle } = mountWebApp(true, makeSnapshot({ interactive: makeInteractive({ runtime }) }))
    try {
      expect(handle.container.querySelector(".topbar-project")?.textContent).toBe("demo / src")
      act(() => adapter.emit(makeSnapshot({ interactive: makeInteractive({ runtime: { ...runtime, gitWorkspace: { kind: "unavailable", message: "Git 不可用" } } }) })))
      expect(handle.container.querySelector(".topbar-project")?.textContent).toBe("src")
    } finally { handle.unmount() }
  })

  test("顶栏品牌使用设计稿 Command 图标", () => {
    const { handle } = mountWebApp(true, makeSnapshot())
    try {
      const mark = handle.container.querySelector(".brand-mark")
      const logo = mark?.querySelector("svg.harness-brand-logo")
      expect(logo).not.toBeNull()
      expect(logo?.getAttribute("viewBox")).toBe("0 0 24 24")
      expect(logo?.classList.contains("lucide-command")).toBe(true)
      expect(mark?.querySelector("svg.lucide-shield")).toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("active Run 时「返回 TUI」按钮被禁用并展示 reason", () => {
    const interactive = makeInteractive({
      activeRun: { threadId: "t1", runId: "r1" },
    })
    const { handle } = mountWebApp(true, makeSnapshot({ interactive }))
    try {
      const returnButton = handle.container.querySelector<HTMLButtonElement>(".return-button")
      expect(returnButton?.disabled).toBe(true)
      expect(returnButton?.title).toBe("当前任务结束或交互完成后可返回 TUI")
    } finally {
      handle.unmount()
    }
  })

  test("active 切换时 WebApp 重新读取 adapter.getSnapshot 并重新渲染", () => {
    const adapter = createFakeAdapter(makeSnapshot({ draft: "first" }))
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      const composer = handle.container.querySelector<HTMLTextAreaElement>(".composer-textarea")
      expect(composer?.value).toBe("first")
      act(() => {
        adapter.emit(makeSnapshot({ draft: "second" }))
      })
      const updated = handle.container.querySelector<HTMLTextAreaElement>(".composer-textarea")
      expect(updated?.value).toBe("second")
    } finally {
      handle.unmount()
    }
  })

  test("header menu 不再提供主题与审批模式入口（均已在顶栏）：只保留帮助与退出", () => {
    const { adapter, handle } = mountWebApp(true, makeSnapshot())
    try {
      act(() => {
        adapter.emit(makeSnapshot({ headerMenuOpen: true }))
      })
      const items = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".header-menu-item"))
      expect(items.map(item => item.textContent)).toEqual(["帮助", "退出 Harness"])
    } finally {
      handle.unmount()
    }
  })

  test("handoffControls={false}：没有返回 TUI 按钮，header menu 只剩帮助，composer 正常可用", () => {
    const adapter = createFakeAdapter(makeSnapshot())
    const handle = render(<WebApp adapter={adapter} active={true} handoffControls={false} />)
    try {
      expect(handle.container.querySelector(".return-button")).toBeNull()
      act(() => {
        adapter.emit(makeSnapshot({ headerMenuOpen: true }))
      })
      const items = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".header-menu-item"))
      expect(items.map(item => item.textContent)).toEqual(["帮助"])
      expect(handle.container.querySelector("textarea")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("连接断开（只读）时 Tool 仍可展开：本地表现不受连接状态阻断", () => {
    const interactive = makeInteractive({
      connection: { status: "closed", message: "连接已断开" },
      timeline: [
        {
          type: "tool",
          tool: { id: "t1", runId: "run-1", name: "exec", arguments: "", output: "结果", status: "completed" },
        },
      ],
    })
    const { adapter, handle } = mountWebApp(true, makeSnapshot({ interactive }))
    try {
      expect(handle.container.querySelector('.connection-banner[role="alert"]')?.textContent).toBe("连接已断开")
      const header = handle.container.querySelector<HTMLButtonElement>(".tool-row-header")
      expect(header).not.toBeNull()
      act(() => { header?.click() })
      expect(adapter.intentLog).toContainEqual({ type: "tool-toggle", runId: "run-1", toolId: "t1" })
    } finally {
      handle.unmount()
    }
  })

  test("data-theme 跟随 snapshot.theme 变化；theme-set 派发到 adapter", () => {
    const adapter = createFakeAdapter(makeSnapshot())
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      const shell = handle.container.querySelector(".web-shell")
      expect(shell?.getAttribute("data-theme")).toBe("light")
      act(() => {
        adapter.emit(makeSnapshot({ theme: "dark" }))
      })
      expect(shell?.getAttribute("data-theme")).toBe("dark")
    } finally {
      handle.unmount()
    }
  })

  test("主题切换在顶栏图标按钮：icon 与 aria-label 表达下一动作；overflow trigger 具备 aria-haspopup/aria-expanded", () => {
    const adapter = createFakeAdapter(makeSnapshot())
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      const trigger = handle.container.querySelector<HTMLButtonElement>(".overflow-trigger")
      expect(trigger?.getAttribute("aria-haspopup")).toBe("menu")
      expect(trigger?.getAttribute("aria-expanded")).toBe("false")
      expect(handle.container.querySelector(".header-menu")).toBeNull()

      // light → 展示 Moon（点击切深色）；dark → 展示 Sun（点击切浅色）。
      const toggle = handle.container.querySelector<HTMLButtonElement>(".theme-toggle")
      expect(toggle?.getAttribute("aria-label")).toBe("切换到深色主题")
      expect(toggle?.querySelector("svg.lucide-moon")).not.toBeNull()

      act(() => { toggle?.click() })
      expect(adapter.intentLog).toContainEqual({ type: "theme-set", theme: "dark" })

      act(() => {
        adapter.emit(makeSnapshot({ theme: "dark" }))
      })
      expect(toggle?.getAttribute("aria-label")).toBe("切换到浅色主题")
      expect(toggle?.querySelector("svg.lucide-sun")).not.toBeNull()

      act(() => { trigger?.click() })
      expect(adapter.intentLog).toContainEqual({ type: "header-menu-toggle", open: true })
    } finally {
      handle.unmount()
    }
  })

  test("overflow menu 支持 Arrow/Home/End 焦点导航", () => {
    const adapter = createFakeAdapter(makeSnapshot({ headerMenuOpen: true }))
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      const menu = handle.container.querySelector<HTMLElement>(".header-menu")
      const items = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".header-menu-item"))
      items[0]?.focus()
      act(() => { menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })) })
      expect(document.activeElement).toBe(items[items.length - 1])
      act(() => { menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })) })
      expect(document.activeElement).toBe(items[0])
    } finally {
      handle.unmount()
    }
  })

  test("执行中无浮层 Escape 只提示中断，不 cancel-run", () => {
    const adapter = createFakeAdapter(makeSnapshot({
      interactive: makeInteractive({ activeRun: { threadId: "t", runId: "r" } }),
    }))
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      expect(adapter.intentLog).toContainEqual({ type: "interrupt-hint" })
      expect(adapter.intentLog.find(intent => intent.type === "cancel-run")).toBeUndefined()
    } finally {
      handle.unmount()
    }
  })

  test("Escape 先关 BTW/查看浮层，不提示中断也不 cancel-run", () => {
    const adapter = createFakeAdapter(makeSnapshot({
      interactive: makeInteractive({ activeRun: { threadId: "t", runId: "r" } }),
      btw: { visible: true, question: "这个报错是什么意思", status: "ready", answer: "权限错误" },
    }))
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      expect(handle.container.textContent).toContain("这个报错是什么意思")
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      expect(adapter.intentLog).toContainEqual({ type: "btw-close" })
      expect(adapter.intentLog.find(intent => intent.type === "interrupt-hint")).toBeUndefined()
      expect(adapter.intentLog.find(intent => intent.type === "cancel-run")).toBeUndefined()
    } finally {
      handle.unmount()
    }
  })

  test("Escape 优先级：header menu 打开时先关闭菜单而非关闭 Dock", () => {
    const adapter = createFakeAdapter(makeSnapshot({
      headerMenuOpen: true,
      contextDock: { open: true, activePanel: "status", widthPx: 560, code: { tabs: [], activePath: null, previews: {}, previewErrors: {} } },
    }))
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      expect(adapter.intentLog).toContainEqual({ type: "header-menu-toggle", open: false })
      expect(adapter.intentLog.find(intent => intent.type === "dock-close")).toBeUndefined()
    } finally {
      handle.unmount()
    }
  })

  test("Dock 打开时渲染 .context-dock，且中间 Conversation（composer）不被预览替换", () => {
    const adapter = createFakeAdapter(makeSnapshot({
      contextDock: { open: true, activePanel: "code", widthPx: 560, code: { tabs: [], activePath: null, previews: {}, previewErrors: {} } },
    }))
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      expect(handle.container.querySelector(".context-dock")).not.toBeNull()
      expect(handle.container.querySelector(".context-dock")?.getAttribute("aria-hidden")).toBeNull()
      expect(handle.container.querySelector(".context-dock")?.hasAttribute("inert")).toBe(false)
      expect(handle.container.querySelector(".desktop-workspace")?.classList.contains("has-context-dock")).toBe(true)
      const composer = handle.container.querySelector<HTMLTextAreaElement>(".composer-textarea")
      expect(composer).not.toBeNull() // Conversation 永不被文件预览替换
    } finally {
      handle.unmount()
    }
  })

  test("Dock 关闭时 .context-dock 保持挂载但 inert/aria-hidden（平移过渡载体），workspace 不带 has-context-dock", () => {
    const adapter = createFakeAdapter(makeSnapshot())
    const handle = render(<WebApp adapter={adapter} active={true} />)
    try {
      const dock = handle.container.querySelector(".context-dock")
      expect(dock).not.toBeNull() // 保持挂载：开关平移过渡的载体，视觉隐藏由 CSS visibility 表达
      expect(dock?.getAttribute("aria-hidden")).toBe("true")
      expect(dock?.hasAttribute("inert")).toBe(true)
      expect(handle.container.querySelector(".desktop-workspace")?.classList.contains("has-context-dock")).toBe(false)
    } finally {
      handle.unmount()
    }
  })
})

 test("顶栏可重新打开文件面板；对话页签与就绪状态同一行，不显示会话标题", () => {
  const { adapter, handle } = mountWebApp(true, makeSnapshot())
  try {
    const toggle = handle.container.querySelector<HTMLButtonElement>('[aria-label="展开右侧面板"]')!
    expect(toggle).not.toBeNull()
    act(() => toggle.click())
    expect(adapter.intentLog).toContainEqual({ type: "dock-open", panel: "code" })
    const toolbar = handle.container.querySelector(".workbench-view-toolbar")
    expect(toolbar?.textContent).toContain("对话")
    expect(toolbar?.textContent).toContain("就绪")
    expect(toolbar?.querySelector('[aria-label="查看文件变更"]')).not.toBeNull()
    expect(handle.container.querySelector(".conversation-heading")).toBeNull()
    expect(handle.container.querySelector(".conversation-column h1")).toBeNull()
    expect(handle.container.textContent).not.toContain("本地工作区")
  } finally { handle.unmount() }
})

test("Git 忙碌提示不误称为尚未接管，输入和新建均禁用",()=>{
 const {handle}=mountWebApp(true,makeSnapshot({interactive:makeInteractive({git:{busy:true,repository:null,diff:null,result:null,error:null}})}))
 try{expect(handle.container.textContent).toContain("Git 操作进行中");expect(handle.container.querySelector<HTMLTextAreaElement>(".composer-textarea")?.disabled).toBe(true);expect(handle.container.querySelector<HTMLButtonElement>(".new-thread-button")?.disabled).toBe(true)}finally{handle.unmount()}
})

test("设置打开与关闭保留 Git 勾选、提交说明、滚动和会话草稿，Escape 不关闭 Dock", () => {
  const base = makeSnapshot({
    draft: "未发送的对话",
    settings: { open: false, activePanel: "help" },
    contextDock: { ...makeSnapshot().contextDock, open: true, activePanel: "changes" },
    interactive: makeInteractive({ git: {
      busy: false, error: null, result: null, diff: null,
      repository: { snapshot: "s1", branch: "main", head: "head", upstream: null, blockedReason: null,
        files: [{ path: "a.ts", oldPath: null, status: " M", fingerprint: "f1" }] },
    } }),
  })
  const { adapter, handle } = mountWebApp(true, base)
  try {
    const selected = handle.container.querySelector<HTMLInputElement>('[data-file-check]')!
    const message = handle.container.querySelector<HTMLTextAreaElement>('.git-commit textarea')!
    const review = handle.container.querySelector<HTMLElement>('.git-review')!
    act(() => selected.click())
    act(() => setControlledValue(message, "保留提交说明"))
    review.scrollTop = 72
    const trigger = handle.container.querySelector<HTMLButtonElement>('[data-settings-trigger]')!
    trigger.focus()
    act(() => trigger.click())
    expect(adapter.intentLog).toContainEqual({ type: "settings-open" })
    act(() => adapter.emit({ ...base, settings: { open: true, activePanel: "help" } }))
    expect(handle.container.querySelector('.workbench-content')?.hasAttribute('inert')).toBe(true)
    const close = handle.container.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!
    expect(document.activeElement === close).toBe(true)
    act(() => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(adapter.intentLog).toContainEqual({ type: "settings-close" })
    expect(adapter.intentLog.some(intent => intent.type === "dock-close")).toBe(false)
    act(() => adapter.emit(base))
    expect(document.activeElement === trigger).toBe(true)
    expect(handle.container.querySelector('[data-file-check]') === selected).toBe(true)
    expect(selected.checked).toBe(true)
    expect(message.value).toBe("保留提交说明")
    expect(review.scrollTop).toBe(72)
    expect(handle.container.querySelector<HTMLTextAreaElement>('.composer-textarea')?.value).toBe("未发送的对话")
  } finally { handle.unmount() }
})

test("设置内的确认框优先接收 Escape，取消后仍保留设置分类", () => {
  const base = makeSnapshot({ settings: { open: true, activePanel: "mcp" } })
  const { adapter, handle } = mountWebApp(true, base)
  try {
    act(() => adapter.emit({ ...base, interactive: { ...base.interactive, confirmation: {
      confirmationId: "settings-confirm", title: "移除 MCP", message: "确认移除？",
    } } }))
    expect(handle.container.querySelector('.settings-overlay')?.hasAttribute('inert')).toBe(true)
    const confirm = handle.container.querySelector<HTMLButtonElement>('.dialog-confirm')!
    expect(document.activeElement === confirm).toBe(true)
    act(() => confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(adapter.intentLog).toEqual([{ type: "confirmation-resolve", confirmationId: "settings-confirm", confirmed: false }])
    act(() => adapter.emit(base))
    expect(handle.container.querySelector('.settings-overlay')?.hasAttribute('inert')).toBe(false)
    expect(handle.container.querySelector('.settings-dialog')?.contains(document.activeElement)).toBe(true)
  } finally { handle.unmount() }
})

test("设置内查看浮层获得焦点，Escape 只关闭查看并回到设置", () => {
  const base = makeSnapshot({ settings: { open: true, activePanel: "mcp" } })
  const { adapter, handle } = mountWebApp(true, base)
  try {
    act(() => adapter.emit({ ...base, inspectOverlay: { visible: true, kind: "mcp", title: "MCP 详情", body: "已连接" } }))
    const overlay = handle.container.querySelector('.runtime-overlay')!
    expect(overlay.contains(document.activeElement)).toBe(true)
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(adapter.intentLog).toEqual([{ type: "inspect-overlay-close" }])
    act(() => adapter.emit(base))
    expect(handle.container.querySelector('.settings-dialog')?.contains(document.activeElement)).toBe(true)
  } finally { handle.unmount() }
})


test("轨迹页签切换保留聊天 DOM 和右栏实例，隐藏区域不可聚焦", () => {
  const base = makeSnapshot()
  const initial = makeSnapshot({ draft: "保留草稿", contextDock: { ...base.contextDock, open: true } })
  const { adapter, handle } = mountWebApp(true, initial)
  try {
    const composer = handle.container.querySelector(".composer-textarea")
    const dock = handle.container.querySelector(".context-dock")
    const tab = handle.container.querySelector<HTMLButtonElement>('[role="tab"][data-view="trace"]')
    expect(tab).not.toBeNull()
    act(() => tab!.click())
    expect(adapter.intentLog.at(-1)).toEqual({ type: "view-mode-set", mode: "trace" })
    act(() => adapter.emit({ ...initial, viewMode: "trace" }))
    expect(handle.container.querySelector(".composer-textarea")).toBe(composer)
    expect(handle.container.querySelector(".context-dock")).toBe(dock)
    expect(handle.container.querySelector(".conversation-chat")?.hasAttribute("hidden")).toBe(true)
    expect(dock?.getAttribute("aria-hidden")).toBe("true")
    expect(handle.container.querySelector(".desktop-workspace")?.classList.contains("has-context-dock")).toBe(false)
    act(() => adapter.emit(initial))
    expect(handle.container.querySelector(".composer-textarea")).toBe(composer)
    expect(handle.container.querySelector(".conversation-chat")?.hasAttribute("hidden")).toBe(false)
    expect(dock?.getAttribute("aria-hidden")).toBeNull()
  } finally { handle.unmount() }
})
