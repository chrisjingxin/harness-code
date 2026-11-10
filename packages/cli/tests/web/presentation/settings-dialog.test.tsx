/** 设置窗口：分类导航、能力门禁、焦点与右侧上下文分离。 */
/** @jsxImportSource react */

import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { SettingsDialog } from "../../../src/web/presentation/settings-dialog"
import type { SettingsPanel, WebAdapterSnapshot, WebIntent } from "../../../src/web/application/adapter"
import { makeAgent, makeCatalog, makeInteractive, makeMcp, makeModel, makeRuntime, makeSkill, makeSnapshot } from "./fixtures"
import { registerTestDom, render } from "./render"

const unregisterTestDom = registerTestDom()
afterAll(() => unregisterTestDom())

test("设置窗口显示六类，方向键切换，Tab 循环，Escape 仅关闭设置并恢复焦点", () => {
  const trigger = document.createElement("button")
  const intents: WebIntent[] = []
  const handle = render(<SettingsDialog snapshot={makeSnapshot()} dispatch={intent => intents.push(intent)} />)
  document.body.append(trigger)
  trigger.focus()
  act(() => handle.root.render(<SettingsDialog snapshot={makeSnapshot({ settings: { open: true, activePanel: "help" } })} dispatch={intent => intents.push(intent)} />))
  try {
    const dialog = handle.container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    const tabs = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.map(tab => tab.textContent)).toEqual(["模型", "技能", "MCP", "Agent", "运行状态", "帮助"])
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!
    expect(document.activeElement).toBe(close)
    act(() => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(tabs[5])
    act(() => tabs[5]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })))
    expect(intents).toContainEqual({ type: "settings-panel-select", panel: "models" })
    act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(intents).toContainEqual({ type: "settings-close" })
    expect(intents.some(intent => intent.type === "dock-close")).toBe(false)
  } finally {
    act(() => handle.root.render(<SettingsDialog snapshot={makeSnapshot()} dispatch={intent => intents.push(intent)} />))
    expect(document.activeElement === trigger).toBe(true)
    handle.unmount()
    trigger.remove()
  }
})

test("无目录能力时仅显示运行状态和帮助，不泄露隐藏分类内容", () => {
  const snapshot = makeSnapshot({ settings: { open: true, activePanel: "models" }, interactive: makeInteractive({ runtime: makeRuntime({ capabilities: [] }) }) })
  const handle = render(<SettingsDialog snapshot={snapshot} dispatch={() => {}} />)
  try {
    expect(Array.from(handle.container.querySelectorAll('[role="tab"]')).map(tab => tab.textContent)).toEqual(["运行状态", "帮助"])
    expect(handle.container.querySelector('.status-view')).not.toBeNull()
    expect(handle.container.querySelector('.models-view')).toBeNull()
  } finally { handle.unmount() }
})

function settingsSnapshot(activePanel: SettingsPanel, overrides: Partial<WebAdapterSnapshot> = {}): WebAdapterSnapshot {
  return makeSnapshot({ settings: { open: true, activePanel }, ...overrides })
}

function mountSettings(snapshot: WebAdapterSnapshot, intents: WebIntent[]) {
  return render(<SettingsDialog snapshot={snapshot} dispatch={intent => intents.push(intent)} />)
}

test("activePanel=models 列出 Profile 并 dispatch model-select", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    catalogs: {
      ...makeInteractive().catalogs,
      models: makeCatalog([makeModel({ id: "p1", model: "gpt-x", provider_label: "Prov" }), makeModel({ id: "p2", model: "gpt-y", provider_label: "Prov" })]),
    },
  })
  const handle = mountSettings(settingsSnapshot("models", { interactive }), intents)
  try {
    const items = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".panel-item"))
    expect(items.length).toBe(2)
    act(() => { items[1]?.click() })
    expect(intents).toContainEqual({ type: "model-select", profileId: "p2" })
  } finally {
    handle.unmount()
  }
})

test("activePanel=skills 无 skills.manage capability 时不渲染启停开关", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    runtime: makeRuntime({ capabilities: ["skills.read"] }),
    catalogs: {
      ...makeInteractive().catalogs,
      skills: makeCatalog([makeSkill({ id: "s1", name: "Skill 1", enabled: true, userInvocable: true })]),
    },
  })
  const handle = mountSettings(settingsSnapshot("skills", { interactive }), intents)
  try {
    const items = handle.container.querySelectorAll(".panel-item")
    expect(items.length).toBe(1)
    expect(handle.container.querySelector(".skill-toggle")).toBeNull()
  } finally {
    handle.unmount()
  }
})

test("activePanel=skills 具备 skills.manage 时显示启停开关；切换 dispatch skill-set-enabled", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    runtime: makeRuntime({ capabilities: ["skills.read", "skills.manage"] }),
    catalogs: {
      ...makeInteractive().catalogs,
      skills: makeCatalog([makeSkill({ id: "s1", name: "Skill 1", enabled: true, userInvocable: true })]),
    },
  })
  const handle = mountSettings(settingsSnapshot("skills", { interactive }), intents)
  try {
    const toggle = handle.container.querySelector<HTMLInputElement>(".skill-toggle input[type=checkbox]")
    expect(toggle).not.toBeNull()
    expect(toggle?.checked).toBe(true)
    act(() => { toggle?.click() })
    expect(intents).toContainEqual({ type: "skill-set-enabled", skillId: "s1", enabled: false })
  } finally {
    handle.unmount()
  }
})

test("activePanel=skills 列表中 disabled Skill 不可被 arm", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    runtime: makeRuntime({ capabilities: ["skills.read", "skills.manage"] }),
    catalogs: {
      ...makeInteractive().catalogs,
      skills: makeCatalog([
        makeSkill({ id: "s1", name: "已停用", enabled: false, userInvocable: true }),
        makeSkill({ id: "s2", name: "可用", enabled: true, userInvocable: true }),
      ]),
    },
  })
  const handle = mountSettings(settingsSnapshot("skills", { interactive }), intents)
  try {
    const items = Array.from(handle.container.querySelectorAll<HTMLButtonElement>(".panel-item"))
    const disabled = items.find(button => button.getAttribute("data-disabled") === "true")
    expect(disabled?.textContent).toContain("已停用")
    act(() => { disabled?.click() })
    expect(intents.find(intent => intent.type === "skill-arm" && intent.skillId === "s1")).toBeUndefined()
  } finally {
    handle.unmount()
  }
})

test("activePanel=mcp 列出服务器；具备 mcp.manage 时显示删除按钮并 dispatch mcp-remove", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    runtime: makeRuntime({ capabilities: ["mcp.read", "mcp.manage"] }),
    catalogs: {
      ...makeInteractive().catalogs,
      mcp: makeCatalog([makeMcp({ name: "server-a" }), makeMcp({ name: "server-b" })]),
    },
  })
  const handle = mountSettings(settingsSnapshot("mcp", { interactive }), intents)
  try {
    const items = handle.container.querySelectorAll(".panel-list li")
    expect(items.length).toBe(2)
    const removeButtons = handle.container.querySelectorAll<HTMLButtonElement>(".icon-button[aria-label^='移除']")
    expect(removeButtons.length).toBe(2)
    act(() => { removeButtons[0]?.click() })
    expect(intents).toContainEqual({ type: "mcp-remove", name: "server-a" })
  } finally {
    handle.unmount()
  }
})

test("activePanel=agents 列出可派发 Agent，点击不发出 arm/select intent", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    catalogs: {
      ...makeInteractive().catalogs,
      agents: makeCatalog([
        makeAgent({ id: "general-purpose", tools: [], description: "通用子代理" }),
        makeAgent({ id: "explore" }),
      ]),
    },
  })
  const handle = mountSettings(settingsSnapshot("agents", { interactive }), intents)
  try {
    const text = handle.container.textContent ?? ""
    expect(text).toContain("general-purpose")
    expect(text).toContain("explore")
    expect(text).toContain("内置")
    expect(text).toContain("研究、搜索和把事情做完")
    expect(text).toContain("只读搜索代码，找出文件和结构")
    expect(text).not.toContain("glob")
    expect(text).not.toContain("继承父能力")
    expect(handle.container.querySelectorAll("button.panel-item").length).toBe(0)
    expect(intents).toEqual([])
  } finally {
    handle.unmount()
  }
})

test("activePanel=status 只读展示 runtime 与连接信息；内部不出现业务操作按钮", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    runtime: makeRuntime({ workspace: "/workspace", modelName: "gpt-x", gitWorkspace: { kind: "branch", branch: "main", root: "/workspace" } }),
    connection: { status: "open" },
  })
  const handle = mountSettings(settingsSnapshot("status", { interactive }), intents)
  try {
    const status = handle.container.querySelector(".status-view")
    expect(status).not.toBeNull()
    expect(status?.textContent).toContain("workspace")
    expect(status?.textContent).toContain("gpt-x")
    expect(status?.textContent).toContain("main")
    const businessButtons = status?.querySelectorAll("button")
    expect(businessButtons?.length ?? 0).toBe(0)
  } finally {
    handle.unmount()
  }
})

test("activePanel=models 加载错误时点击重试 dispatch settings-panel-select models", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({
    catalogs: {
      ...makeInteractive().catalogs,
      models: makeCatalog([], "error", "请求失败"),
    },
  })
  const handle = mountSettings(settingsSnapshot("models", { interactive }), intents)
  try {
    const retry = handle.container.querySelector<HTMLButtonElement>(".panel-error button")
    expect(retry).not.toBeNull()
    act(() => { retry?.click() })
    expect(intents).toContainEqual({ type: "settings-panel-select", panel: "models" })
  } finally {
    handle.unmount()
  }
})

test("activePanel=help 时帮助 tab 选中；内容列出命令", () => {
  const intents: WebIntent[] = []
  const interactive = makeInteractive({ commands: [] })
  const handle = mountSettings(settingsSnapshot("help", { interactive }), intents)
  try {
    const helpTab = handle.container.querySelector<HTMLButtonElement>('[role="tab"][data-panel="help"]')
    expect(helpTab?.getAttribute("aria-selected")).toBe("true")
    expect(handle.container.querySelector('[role="tablist"]')).not.toBeNull()
    expect(handle.container.querySelector(".help-view")).not.toBeNull()
  } finally {
    handle.unmount()
  }
})
