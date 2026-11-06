/**
 * 基础工作台。仅消费通用 DesktopHost，不直接访问文件、Node 或 Electron。
 * 控件动作 → 宿主处理 → 实际状态回显；这里没有预置聊天或业务数据。
 */
import { useEffect, useState } from "react"
import type { DesktopHost, ThemeMode, WindowState } from "@workbench/contracts"
import "./theme.css"

/** 为原生桌面组合的基础内容；窗口状态订阅随组件销毁解除。 */
export function Workbench({ host }: { host: DesktopHost }) {
  const [state, setState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  const [directory, setDirectory] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    let active = true
    const apply = (next: WindowState) => { if (active) setState(next) }
    const unsubscribe = host.onWindowStateChanged(apply)
    host.getWindowState().then(apply).catch(() => { if (active) setError("无法读取窗口状态，请重试。") })
    return () => { active = false; unsubscribe() }
  }, [host])
  useEffect(() => { document.documentElement.dataset.theme = state.colorScheme }, [state.colorScheme])
  async function update(request: () => Promise<WindowState>) {
    setError("")
    try { setState(await request()) } catch { setError("窗口设置未成功，请重试。") }
  }
  async function chooseDirectory() {
    setChoosing(true); setError("")
    try {
      const path = await host.chooseDirectory()
      if (path !== null) setDirectory(path)
    } catch { setError("无法打开目录选择器，请重试。") }
    finally { setChoosing(false) }
  }
  return <div className="workbench">
    <header className="titlebar"><span className="brand-mark">W</span><span>协作工作台</span><span className="stage">基础桌面</span></header>
    <main>
      <div className="eyebrow">WORKBENCH</div>
      <h1>从本机开始</h1>
      <p className="intro">选择一个目录，整理你的工作空间。</p>
      <section className="project-card" aria-labelledby="directory-heading">
        <span className="folder-icon" aria-hidden="true">⌑</span>
        <div className="project-copy"><h2 id="directory-heading">工作目录</h2><p className="directory" data-testid="directory">{directory ?? "尚未选择目录"}</p></div>
        <button className="primary" disabled={choosing} onClick={() => { void chooseDirectory() }}>{choosing ? "正在选择…" : "选择目录"}</button>
      </section>
      <p className="hint">当前仅显示所选路径，不会读取或上传目录内容。</p>
      <section className="preferences" aria-label="窗口外观">
        <label>外观<select aria-label="外观" value={state.themeMode} onChange={event => { void update(() => host.setThemeMode(event.target.value as ThemeMode)) }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
        <div className="zoom-control"><span>窗口缩放</span><div className="zoom-buttons"><button aria-label="缩小" disabled={state.zoomPercent <= 80} onClick={() => { void update(() => host.adjustZoom("out")) }}>−</button><button aria-label="恢复缩放" onClick={() => { void update(() => host.adjustZoom("reset")) }}>{state.zoomPercent}%</button><button aria-label="放大" disabled={state.zoomPercent >= 150} onClick={() => { void update(() => host.adjustZoom("in")) }}>+</button></div></div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      <footer>基础桌面已就绪。会话与协作功能将在后续版本接入。</footer>
    </main>
  </div>
}
