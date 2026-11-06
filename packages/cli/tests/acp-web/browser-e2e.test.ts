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
import { buildBrowserAssetsInSubprocess } from "./support/build-assets-subprocess"

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

let assetsCache: Awaited<ReturnType<typeof buildBrowserAssetsInSubprocess>> | null = null

// 15 个用例共用一次子进程构建（全量并行时进程内 Bun.build 必发 "Unseekable
// reading file"，见 helper 注释）。
async function webAssets() {
  if (assetsCache) return assetsCache
  assetsCache = await buildBrowserAssetsInSubprocess()
  return assetsCache
}

async function up(scenario: AcpScenario): Promise<Page> {
  const workspace = realpathSync(makePythonWorkspace())
  harness = await startBridge(pythonAgentPlan(scenario, workspace), { cwd: workspace, assets: webAssets })
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


  test("diff 场景：write_file 审批卡片显示文件路径与 diff → 允许后批准后继续", async () => {
    const page = await up("diff")
    await send(page, "写文件")
    await page.getByText("需要批准").first().waitFor({ state: "visible", timeout: 20_000 })
    // file_diff presentation：路径、统一 diff 行与增删统计都要渲染
    await page.getByText("/src/calc.py").first().waitFor({ state: "visible", timeout: 10_000 })
    expect(await page.getByText(/calc helpers|def add\(a, b\)/).count()).toBeGreaterThan(0)
    // FileDiffApproval 渲染 +N/−M 统计（file-diff-stats）
    await page.locator(".file-diff-added").first().waitFor({ state: "visible", timeout: 5_000 })
    expect(await page.locator(".file-diff-added").first().textContent()).toBe("+4")
    await page.getByRole("button", { name: "允许一次" }).first().click()
    await page.getByRole("button", { name: "提交", exact: true }).first().click()
    await page.getByText("批准后继续").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "s4-diff-approve")
  }, 90_000)

  test("diff 场景：拒绝 → 已拒绝", async () => {
    const page = await up("diff")
    await send(page, "写文件")
    await page.getByText("需要批准").first().waitFor({ state: "visible", timeout: 20_000 })
    await page.getByText("/src/calc.py").first().waitFor({ state: "visible", timeout: 10_000 })
    await page.getByRole("button", { name: "拒绝" }).first().click()
    await page.getByText("已拒绝").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "s4-diff-reject")
  }, 90_000)

  test("trust 场景：目录信任卡片 → 允许 → 信任已登记", async () => {
    const page = await up("trust")
    await send(page, "看一眼 /ext")
    await page.getByText(/目录信任|加入白名单/).first().waitFor({ state: "visible", timeout: 20_000 })
    await page.getByText("/ext").first().waitFor({ state: "visible", timeout: 10_000 })
    await page.locator(".directory-trust-form .approval-button-positive").first().click()
    await page.getByText("信任已登记").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "s4-trust-allow")
  }, 90_000)

  test("trust 场景：拒绝 → 已拒绝信任", async () => {
    const page = await up("trust")
    await send(page, "看一眼 /ext")
    await page.getByText(/目录信任|加入白名单/).first().waitFor({ state: "visible", timeout: 20_000 })
    await page.locator(".directory-trust-form .approval-button-negative").first().click()
    await page.getByText("已拒绝信任").first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "s4-trust-reject")
  }, 90_000)

  test("刷新恢复：history 场景 reload 后凭据重放、会话保留可回放", async () => {
    const page = await up("history")
    await page.getByText("先看一眼").first().waitFor({ state: "visible", timeout: 15_000 })
    await page.reload()
    // 二次握手走 sessionStorage 里的 boot code，不能再落到"本地 Agent 暂时不可用"。
    await page.waitForSelector("textarea", { timeout: 20_000 })
    expect(await page.getByText("本地 Agent 暂时不可用").count()).toBe(0)
    const item = page.getByText("先看一眼").first()
    await item.waitFor({ state: "visible", timeout: 15_000 })
    await item.click()
    await page.getByText("看完了。").first().waitFor({ state: "visible", timeout: 15_000 })
    await shot(page, "s4-reload-history")
  }, 90_000)

  test("刷新恢复：echo 场景 reload 后重新连上且页面可用", async () => {
    const page = await up("host")
    const marker = `echo-${Date.now()}`
    await send(page, marker)
    await page.getByText(marker).nth(1).waitFor({ state: "visible", timeout: 15_000 })
    await page.reload()
    await page.waitForSelector("textarea", { timeout: 20_000 })
    expect(await page.getByText("本地 Agent 暂时不可用").count()).toBe(0)
    // echo 模式没有线程存储（server.py: THREADS_UNAVAILABLE_IN_ECHO_MODE），
    // 刚跑的 session 不进 session/list——这里锁「刷新后新引导可用」：
    // 再发一条能收到回显，证明新子进程/新连接真正可用。
    const marker2 = `echo2-${Date.now()}`
    await send(page, marker2)
    await page.getByText(marker2).nth(1).waitFor({ state: "visible", timeout: 15_000 })
    await shot(page, "s4-reload-host")
  }, 90_000)

  test("崩溃界面：SIGKILL 子进程后界面显示进程已退出", async () => {
    const page = await up("host")
    const spawned = await harness!.waitForEvent(e => e.event === "agent.spawned")
    expect(typeof spawned.pid).toBe("number")
    process.kill(spawned.pid!, "SIGKILL")
    await page.getByText(/本地 Agent 进程已退出（退出码/).first().waitFor({ state: "visible", timeout: 20_000 })
    await shot(page, "s4-crash")
  }, 90_000)

  test("关闭回收：page.close() 后子进程 8s 内退出", async () => {
    const page = await up("host")
    const spawned = await harness!.waitForEvent(e => e.event === "agent.spawned")
    const pid = spawned.pid!
    expect(typeof pid).toBe("number")
    await page.close()
    const deadline = Date.now() + 8_000
    let alive = true
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { alive = false; break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(alive).toBe(false)
  }, 60_000)

  test("控制台无 CSP 违规与 pageerror", () => {
    expect(consoleErrors).toEqual([])
  })
})
