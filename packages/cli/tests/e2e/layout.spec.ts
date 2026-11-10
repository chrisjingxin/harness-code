/** 真实浏览器几何回归：关闭图标居中、上下区域分配、矮窗口操作可达与 Trace 缩放。 */
import { expect, test, type Locator } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

let server: ChildProcess
let origin: string
// 几何断言针对稳定布局，避免采到主题/轨道过渡的中间帧。
test.use({ contextOptions: { reducedMotion: "reduce" } })
test.beforeAll(async () => {
  server = spawn("bun", [fileURLToPath(new URL("./layout-server.ts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] })
  origin = await new Promise<string>((resolve, reject) => {
    let output = ""
    server.stdout!.on("data", chunk => { output += chunk; const match = output.match(/LAYOUT_URL=(http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]!) })
    server.stderr!.on("data", chunk => { output += chunk })
    server.on("exit", () => reject(new Error(output)))
    server.on("error", reject)
  })
})
test.afterAll(() => { server?.kill() })

async function box(locator: Locator) {
  await expect(locator).toBeVisible()
  return (await locator.boundingBox())!
}

test("文件标签关闭图标位于按钮正中，点击关闭后另一标签仍可用", async ({ page }) => {
  await page.goto(origin)
  const button = page.getByRole("button", { name: "关闭 package.json", exact: true })
  const outer = await box(button), icon = await box(button.locator("svg"))
  expect(Math.abs(icon.x + icon.width / 2 - outer.x - outer.width / 2)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(icon.y + icon.height / 2 - outer.y - outer.height / 2)).toBeLessThanOrEqual(0.5)
  await button.click()
  await expect(page.locator(".file-tab")).toHaveCount(1)
  await expect(page.locator(".file-preview-path-text")).toContainText("long-preview-example")
})

for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 600], [1024, 480]]) {
  test(`${width}×${height}：文件树与预览各自滚动，长路径和工具按钮不溢出`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! })
    await page.goto(origin)
    const area = await box(page.locator(".context-dock-code-scroll"))
    const tree = await box(page.locator(".file-explorer")), code = await box(page.locator(".code-panel"))
    expect(tree.height / area.height).toBeGreaterThanOrEqual(0.35)
    expect(tree.height / area.height).toBeLessThanOrEqual(0.45)
    expect(code.y + code.height).toBeLessThanOrEqual(height! + 1)
    if (width === 1440) {
      await page.screenshot({ path: test.info().outputPath("workbench-light.png") })
      await page.getByRole("button", { name: "切换到深色主题" }).click()
      await expect(page.locator(".web-shell")).toHaveAttribute("data-theme", "dark")
      await expect(page.locator('.thread-item-title').first()).toHaveCSS("color", "rgb(240, 240, 243)")
      await page.screenshot({ path: test.info().outputPath("workbench-dark.png") })
    }
    await page.locator(".file-tab").nth(1).click()
    const header = await box(page.locator(".file-preview-header"))
    const refresh = await box(page.getByRole("button", { name: "刷新预览" }))
    expect(refresh.x + refresh.width).toBeLessThanOrEqual(width!)
    expect(refresh.y + refresh.height).toBeLessThanOrEqual(header.y + header.height)
    const view = await box(page.locator(".file-code-view"))
    expect(view.height).toBeGreaterThan(60)
    for (const selector of [".file-tree", ".file-code-view"]) {
      const scroll = await page.locator(selector).evaluate(element => { element.scrollTop = 200; return element.scrollTop })
      expect(scroll).toBeGreaterThan(0)
    }
    expect(await page.locator(".context-dock").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  })
}

test("矮窗口 Git 提交操作可滚动到达，变更区仍有空间", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.goto(`${origin}?panel=changes`)
  expect((await box(page.locator(".git-review"))).height).toBeGreaterThanOrEqual(100)
  const commit = page.getByRole("button", { name: "提交并推送", exact: true })
  await commit.scrollIntoViewIfNeeded()
  const bounds = await box(commit)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(481)
  await expect(page.getByRole("checkbox", { name: "全选变更文件" })).toBeVisible()
})

test("右栏拉宽后缩窗，对话内容宽度跟随实际右栏，保持可读", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(origin)
  const handle = await box(page.getByRole("separator", { name: "调整 Dock 宽度" }))
  await page.mouse.move(handle.x + 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x - 420, handle.y + 100, { steps: 8 })
  await page.mouse.up()
  await page.setViewportSize({ width: 1024, height: 600 })
  const column = await box(page.locator(".conversation-column"))
  const composer = await box(page.locator(".composer-inner"))
  expect(composer.width).toBeGreaterThanOrEqual(column.width - 2)
})

test("深色矮窗口、设置关闭按钮及最后一个文件关闭后的布局", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`${origin}?theme=dark`)
  await expect(page.locator(".web-shell")).toHaveAttribute("data-theme", "dark")
  const available = await box(page.locator(".context-dock-code-scroll"))
  const tree = await box(page.locator(".file-explorer"))
  expect(tree.height / available.height).toBeLessThanOrEqual(0.45)
  while (await page.locator(".file-tab-close").count()) await page.locator(".file-tab-close").first().click()
  expect((await box(page.locator(".file-explorer"))).height).toBeGreaterThanOrEqual(available.height - 1)
  await page.getByRole("button", { name: "设置与工具" }).click()
  const close = page.getByRole("button", { name: "关闭设置" })
  const bounds = await box(close), icon = await box(close.locator("svg"))
  expect(Math.abs(bounds.x + bounds.width / 2 - icon.x - icon.width / 2)).toBeLessThanOrEqual(0.5)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(360)
  await close.click()
  await expect(page.locator(".settings-dialog")).toHaveCount(0)
})

test("窄窗口 Trace 横向滚动可查看详情，不留隐藏侧栏空位", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(`${origin}?view=trace`)
  const column = await box(page.locator(".conversation-column"))
  expect(column.width).toBeGreaterThan(750)
  const scroll = await page.locator(".conversation-trace").evaluate(element => { element.scrollLeft = 1000; return element.scrollLeft })
  // 800px 足以容纳 660px 双列；继续缩窄后应通过横向滚动访问完整内容。
  expect(scroll).toBe(0)
  await page.setViewportSize({ width: 600, height: 600 })
  expect(await page.locator(".conversation-trace").evaluate(element => { element.scrollLeft = 1000; return element.scrollLeft })).toBeGreaterThan(0)
  const detail = await box(page.locator(".trace-pane-detail"))
  expect(detail.x + detail.width).toBeLessThanOrEqual(600)
})

test("Trace 放大面板后缩小窗口，三轨与调用树、详情均保留可用空间", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}?view=trace`)
  const drag = await box(page.getByRole("separator", { name: "调整甘特图高度" }))
  await page.mouse.move(drag.x + drag.width / 2, drag.y + 4)
  await page.mouse.down()
  await page.mouse.move(drag.x + drag.width / 2, drag.y + 800, { steps: 10 })
  await page.mouse.up()
  const vertical = await box(page.getByRole("separator", { name: "调整详情宽度" }))
  await page.mouse.move(vertical.x + 4, vertical.y + 30)
  await page.mouse.down()
  await page.mouse.move(vertical.x - 480, vertical.y + 30, { steps: 8 })
  await page.mouse.up()
  await page.setViewportSize({ width: 1024, height: 480 })
  expect((await box(page.locator(".trace-view-body"))).height).toBeGreaterThanOrEqual(120)
  expect((await box(page.locator(".trace-pane-tree"))).width).toBeGreaterThanOrEqual(200)
  const plot = await box(page.locator(".trace-gantt-plot"))
  for (const bar of await page.locator(".trace-gantt-bar").all()) {
    const bounds = await box(bar)
    expect(bounds.y).toBeGreaterThanOrEqual(plot.y)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(plot.y + plot.height)
  }
})


for (const theme of ["light", "dark"]) {
  test(`中央文件页签 ${theme}：打开去重、独立关闭、键盘、滚动和草稿保留`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${origin}?theme=${theme}`)
    const draft = page.locator(".composer-textarea")
    await draft.fill("尚未发送的草稿")
    await page.getByRole("button", { name: "在主区域打开", exact: true }).click()
    const centerTabs = page.getByRole("tablist", { name: "工作区视图", exact: true })
    await expect(centerTabs.getByRole("tab")).toHaveCount(3)
    await expect(centerTabs.getByRole("tab", { name: "package.json", exact: true })).toHaveAttribute("aria-selected", "true")
    await page.getByRole("button", { name: "在主区域打开", exact: true }).click()
    await expect(centerTabs.getByRole("tab")).toHaveCount(3)
    const code = page.locator(".workbench-file-panel:visible .file-code-view")
    await expect(code).toContainText("value179")
    await code.evaluate(element => { element.scrollTop = 350 })
    await page.screenshot({ path: test.info().outputPath(`central-file-${theme}.png`) })
    await page.locator(".context-dock .file-tab").nth(1).click()
    await page.getByRole("button", { name: "在主区域打开", exact: true }).click()
    await expect(centerTabs.getByRole("tab")).toHaveCount(4)
    await page.getByRole("button", { name: "关闭 package.json", exact: true }).click()
    await expect(centerTabs.getByRole("tab")).toHaveCount(4)
    const first = centerTabs.getByRole("tab", { name: "package.json", exact: true })
    await first.click()
    expect(await code.evaluate(element => element.scrollTop)).toBeGreaterThan(300)
    await page.setViewportSize({ width: 1024, height: 480 })
    await page.getByRole("button", { name: "收起右侧面板", exact: true }).click()
    const fileBox = await box(code)
    expect(fileBox.width).toBeGreaterThan(650)
    expect(fileBox.y + fileBox.height).toBeLessThanOrEqual(481)
    await first.focus()
    await first.press("End")
    const last = centerTabs.getByRole("tab").last()
    await expect(last).toBeFocused()
    await last.press("Delete")
    await expect(first).toBeFocused()
    const close = page.getByRole("button", { name: "关闭文件 package.json", exact: true })
    const outer = await box(close), icon = await box(close.locator("svg"))
    expect(Math.abs(icon.x + icon.width / 2 - outer.x - outer.width / 2)).toBeLessThanOrEqual(0.5)
    await close.click()
    await expect(centerTabs.getByRole("tab", { name: "对话", exact: true })).toBeFocused()
    await expect(draft).toHaveValue("尚未发送的草稿")
  })
}
