/** 独立主题夹具：只消费公开 UI 出口和真实窗口外观端口，不连接业务服务。 */
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ThemeMode, WindowState } from "@workbench/contracts"
import { BrandMark, CodeBlock, HighlightedCode, Markdown, RoleAvatar, useSyntaxHighlight } from "@workbench/ui"
import type { RenderingActions } from "@workbench/ui"
import "@workbench/ui/theme.css"
import "./preview.css"

const markdownExample = `### 一份清晰的记录

- 支持 **重点内容** 和列表
- 行内代码可以写成 \`npm run build\`

| 内容 | 状态 |
| --- | --- |
| 主题与图形 | 已就绪 |
| 代码阅读 | 可查看 |

原始内容：<b>只显示文本</b>。图片：![示意图](https://example.invalid/image.png)

[查看说明](https://example.com) · [危险链接](javascript:alert(1))

\`\`\`diff
-const message = "旧内容"
+const message = "新内容"
\`\`\`
`
const initialCode = 'const greeting = "你好，世界 👋"\nconsole.log(greeting)'
const renderingActions: RenderingActions = {
  copyText: text => window.workbench.copyText(text),
  openExternal: href => window.workbench.openExternal(href),
}

function ThemePreview() {
  const [state, setState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  const [error, setError] = useState("")
  const [code, setCode] = useState(initialCode)
  const [pasted, setPasted] = useState("")
  const highlight = useSyntaxHighlight({ code, language: "typescript" })
  useEffect(() => {
    let active = true
    const apply = (next: WindowState) => { if (active) setState(next) }
    const unsubscribe = window.workbench.onWindowStateChanged(apply)
    window.workbench.getWindowState().then(apply).catch(() => { if (active) setError("无法读取窗口外观。") })
    return () => { active = false; unsubscribe() }
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = state.colorScheme }, [state.colorScheme])
  async function update(action: () => Promise<WindowState>) {
    try { setError(""); setState(await action()) }
    catch { setError("窗口外观未能更新，请重试。") }
  }
  return <div className="preview">
    <header className="preview-header">
      <span className="preview-brand"><span className="preview-logo"><BrandMark /></span><span>工作台</span></span>
      <span className="preview-header-title">主题与公共视图</span>
      <span className="preview-tag">预览</span>
    </header>
    <main className="preview-main">
      <div className="preview-heading">
        <div><p className="preview-kicker">工作台外观</p><h1>看见共同的细节</h1><p className="preview-intro">统一的颜色、图形和基础控件，为各个工作区域提供一致的视觉体验。</p></div>
        <div className="preview-controls">
          <label>外观<select aria-label="外观" value={state.themeMode} onChange={event => { void update(() => window.workbench.setThemeMode(event.target.value as ThemeMode)) }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <div className="preview-zoom" aria-label="窗口缩放"><button className="wb-icon-button" aria-label="缩小" disabled={state.zoomPercent <= 80} onClick={() => { void update(() => window.workbench.adjustZoom("out")) }}>−</button><button className="wb-button wb-button-small" aria-label="恢复缩放" onClick={() => { void update(() => window.workbench.adjustZoom("reset")) }}>{state.zoomPercent}%</button><button className="wb-icon-button" aria-label="放大" disabled={state.zoomPercent >= 150} onClick={() => { void update(() => window.workbench.adjustZoom("in")) }}>+</button></div>
        </div>
      </div>
      {error && <p className="preview-error" role="alert">{error}</p>}
      <div className="preview-grid">
        <section className="preview-card preview-identities" aria-labelledby="identities-title">
          <div className="preview-card-heading"><div><p className="preview-number">01 / 图形</p><h2 id="identities-title">熟悉的角色</h2></div><span className="preview-subtle">公共资源</span></div>
          <div className="preview-identity"><RoleAvatar kind="assistant" /><div><strong>Agent</strong><span>清晰呈现每一次回应</span></div></div>
          <div className="preview-identity"><RoleAvatar kind="user" /><div><strong>用户</strong><span>保留原有对话图形</span></div></div>
          <div className="preview-note">图形使用主题语义色，随浅色和深色外观一起调整。</div>
        </section>
        <section className="preview-card preview-colors" aria-labelledby="colors-title">
          <div className="preview-card-heading"><div><p className="preview-number">02 / 颜色</p><h2 id="colors-title">轻而清晰的层次</h2></div></div>
          <div className="preview-swatches"><div><span className="swatch swatch-brand" /><strong>品牌强调</strong></div><div><span className="swatch swatch-surface" /><strong>界面层次</strong></div><div><span className="swatch swatch-line" /><strong>边界分隔</strong></div></div>
          <div className="preview-statuses"><span><i className="status-success" />已完成</span><span><i className="status-warning" />等待中</span><span><i className="status-danger" />未完成</span></div>
        </section>
        <section className="preview-card preview-actions" aria-labelledby="actions-title">
          <div><p className="preview-number">03 / 控件</p><h2 id="actions-title">一致的操作反馈</h2><p>按钮、焦点和状态使用同一组语义颜色。</p></div>
          <div className="preview-action-list"><button className="wb-button wb-button-primary">主要操作</button><button className="wb-button wb-button-secondary">次要操作</button><button className="wb-button wb-button-quiet" disabled>暂不可用</button></div>
        </section>
        <section className="preview-card preview-rendering" aria-labelledby="markdown-title">
          <div className="preview-card-heading"><div><p className="preview-number">04 / 内容</p><h2 id="markdown-title">阅读与代码</h2></div><span className="preview-subtle">Markdown</span></div>
          <Markdown text={markdownExample} actions={renderingActions} />
        </section>
        <section className="preview-card preview-rendering" aria-labelledby="code-title">
          <div className="preview-card-heading"><div><p className="preview-number">05 / 代码</p><h2 id="code-title">编辑与复制</h2></div><span className="preview-subtle">TypeScript</span></div>
          <label className="preview-field">代码内容<textarea aria-label="代码内容" value={code} onChange={event => setCode(event.target.value)} rows={3} spellCheck={false} /></label>
          <CodeBlock code={code} language="typescript" actions={renderingActions} />
          <p className="preview-highlight-status" role="status">{highlight.status === "highlighted" ? "语法着色已就绪" : highlight.status === "loading" ? "正在计算语法着色" : "当前以纯文本显示"}</p>
          <label className="preview-field">粘贴验证<textarea aria-label="粘贴验证" value={pasted} onChange={event => setPasted(event.target.value)} rows={3} spellCheck={false} /></label>
          <div className="preview-file-label">只读文件样式</div>
          <div className="preview-file"><pre aria-hidden="true">1{"\n"}2</pre><pre><code><HighlightedCode code={initialCode} language="typescript" /></code></pre></div>
          <div className="preview-file-label">未知语言回退</div>
          <CodeBlock code={'未知语言保留原文 🌱'} language="unknown-language" />
        </section>
      </div>
    </main>
  </div>
}

createRoot(document.getElementById("root")!).render(<ThemePreview />)
