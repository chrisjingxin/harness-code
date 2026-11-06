/**
 * 浏览器 E2E（设计 §6.8）：真实桥 + 真实 `acp_scripted_main.py` + 真实
 * Chromium（`HARNESS_E2E_CHROMIUM` 指向可执行文件；未配置时跳过）。
 * 所有交互都用 Playwright 真实 click；断言的是界面真实状态。
 * 截图落 `tmp/hc192-s3/screenshots/`。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"

import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright"

import { makePythonWorkspace, pythonAgentPlan, pythonAvailable, type AcpScenario } from "./support/python-agent"
import { startBridge, type BridgeHarness } from "./support/bridge-harness"
import { browserBundle } from "../../src/acp-web/bundle"

const CHROMIUM = process.env.HARNESS_E2E_CHROMIUM
const SHOTS = resolve(import.meta.dir, "../../../..", "tmp/hc192-s3/screenshots")
const SKIP = !pythonAvailable || !CHROMIUM || !existsSync(CHROMIUM)

let browser: Browser | null = null
let harness: BridgeHarness | null = null
const consoleErrors: string[] = []

beforeAll(async () => {
  if (SKIP) return
  mkdirSync(SHOTS, { recursive: true })
  browser = await chromium.launch({ executablePath: CHROMIUM, headless: true })
})

afterEach(async () => {
  await harness?.stop()
  harness = null
})
afterAll(async () => {
  await browser?.close()
})

async function up(scenario: AcpScenario): Promise<Page> {
  const workspace = realpathSync(makePythonWorkspace())
  harness = await startBridge(pythonAgentPlan(scenario, workspace), { cwd: workspace, assets: browserBundle })
  const page = await browser!.newPage()
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text()
    if (/Content-Security-Policy|Refused to/i.test(text)) consoleErrors.push(text)
  })
  page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`))
  await page.goto(`${harness.origin}/#c=${harness.bootCode}`)
  await page.waitForSelector("textarea", { timeout: 20_000 })
  return page
}

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true })
const send = async (page: Page, text: string): Promise<void> => {
  await page.locator("textarea").first().fill(text)
  await page.keyboard.press("Enter")
}

describe.skipIf(SKIP)("浏览器 E2E", () => {
  test("首页渲染 + 发消息 + 流式回显 + 没有返回 TUI", async () => {
    const page = await up("host")
    expect(await page.locator("textarea").count()).toBeGreaterThan(0)
    expect(await page.getByText("返回 TUI").count()).toBe(0)
    await page.getByText(/GAP-11/).first().waitFor({ state: "visible", timeout: 5_000 })
    await send(page, "你好")
    await page.getByText("你好").nth(1).waitFor({ state: "visible", timeout: 15_000 })
    await shot(page, "01-home-echo")
  }, 60_000)

  test("取消：approval 场景 — 审批卡片 → 点停止 → 已取消且无 No active run → 再发 → 允许 → 批准后继续", async () => {
    const page = await up("approval")
    await send(page, "跑一下")
    // 审批卡片出现（工具：execute npm test）
    await page.getByText("需要批准").first().waitFor({ state: "visible", timeout: 20_000 })
    // 点停止按钮（composer 的 cancel-button 真实 click）
    await page.locator(".cancel-button").first().click()
    // 已取消状态：卡片消失 + 时间线出现取消提示，且没有 "No active run"
    await page.getByText(/已取消|cancelled/i).first().waitFor({ state: "visible", timeout: 15_000 })
    expect(await page.getByText("No active run to cancel").count()).toBe(0)
    // 再发一条 → 审批卡片再次出现 → 点"允许一次"选中 → 再点"提交"（批准二次确认）→ "批准后继续"
    await send(page, "再跑一次")
    await page.getByText("需要批准").first().waitFor({ state: "visible", timeout: 20_000 })
    await page.getByRole("button", { name: "允许一次" }).first().click()
    await page.getByRole("button", { name: "提交", exact: true }).first().click()
    await page.getByText("批准后继续").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "02-cancel-resend-approve")
  }, 90_000)

  test("拒绝：approval 场景 — 审批卡片 → 点拒绝 → 已拒绝", async () => {
    const page = await up("approval")
    await send(page, "跑一下")
    await page.getByText("需要批准").first().waitFor({ state: "visible", timeout: 20_000 })
    await page.getByRole("button", { name: "拒绝" }).first().click()
    await page.getByText("已拒绝").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "03-approval-reject")
  }, 90_000)

  test("tools 场景：工具卡片标题含 /note.txt", async () => {
    const page = await up("tools")
    await send(page, "跑工具")
    // 录制帧里有 tool_call（read_file /note.txt）与 agent_thought_chunk
    await page.getByText("/note.txt").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "04-tools-card")
  }, 90_000)

  test("history 场景：侧栏出现会话 → 点击 → 回放消息进时间线", async () => {
    const page = await up("history")
    // listThreads 回填会话列表 — 侧栏出现"先看一眼"
    const threadItem = page.getByText("先看一眼").first()
    await threadItem.waitFor({ state: "visible", timeout: 15_000 })
    await threadItem.click()
    // openThread → session/load 回放：用户消息 + 助手回答都进时间线
    await page.getByText("看完了。").first().waitFor({ state: "visible", timeout: 15_000 })
    await shot(page, "05-history-replay")
  }, 90_000)

  test("缺口提示：点右栏变更页签显示 GAP-12、文件页签显示 GAP-11", async () => {
    const page = await up("host")
    // Context Dock "变更"页签 → Git 面板被网关固定为不支持 → GAP-12。
    await page.getByRole("tab", { name: "变更" }).first().click()
    await page.getByText(/GAP-12/).first().waitFor({ state: "visible", timeout: 10_000 })
    // 切回"文件"页签 → 文件树固定为不支持 → GAP-11。
    await page.getByRole("tab", { name: "文件" }).first().click()
    await page.getByText(/GAP-11/).first().waitFor({ state: "visible", timeout: 10_000 })
    await shot(page, "06-gap-notices")
  }, 90_000)

  test("控制台无 CSP 违规与 pageerror", () => {
    expect(consoleErrors).toEqual([])
  })
})
