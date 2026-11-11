/**
 * 项目变更的 Diff 展示：复用公共解析器，输入始终作为文本，不解释为 HTML。
 * 无法解析的内容保留原文，由上游提供的截断标记单独提示。
 */
import { Fragment, useMemo } from "react"
import type { ReactElement } from "react"
import { parseFileDiff } from "../rendering/file-diff.js"

export function ProjectGitDiff({ text }: { text: string }): ReactElement {
  const parsed = useMemo(() => {
    const start = text.search(/^@@ /m)
    return start < 0 ? null : parseFileDiff(text.slice(start))
  }, [text])

  if (!parsed || parsed.status !== "parsed" || !parsed.hunks.length) {
    return <pre className="project-git-diff-fallback">{text}</pre>
  }
  return <>
    <div className="project-git-diff-lines">
      {parsed.hunks.map((hunk, index) => <Fragment key={index}>
        <div className="project-git-line-hunk">{hunk.header}</div>
        {hunk.lines.map((line, row) => <div key={row} className={`project-git-diff-line project-git-line-${line.kind}`}>
          <span className="project-git-line-number" aria-hidden="true">{line.newLine ?? line.oldLine}</span>
          <span className="project-git-line-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
          <span className="project-git-line-text">{line.text || " "}</span>
        </div>)}
      </Fragment>)}
    </div>
    <details className="project-git-diff-raw"><summary>查看原始 Diff</summary><pre>{text}</pre></details>
  </>
}
