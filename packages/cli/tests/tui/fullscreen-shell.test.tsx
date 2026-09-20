/** HC-183 全屏外壳：响应式 Header、欢迎页、Footer、InputBar 与 Toast 槽位。 */
/** @jsxImportSource react */
import { renderToString } from "ink"
import React from "react"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  FullscreenFooter,
  FullscreenHeader,
  FullscreenInputBar,
  FullscreenWelcome,
  TOAST_VIEWPORT_ROWS,
  ToastViewport,
} from "../../src/tui/ink/fullscreen-shell"
import { FullscreenConversationView } from "../../src/tui/ink/app"

describe("FullscreenHeader", () => {
  it("degrades one line by priority at 40, 72, and 120 columns", () => {
    const props = {
      threadId: "thread-1234567890",
      workMode: "build" as const,
      model: "enterprise-model",
      workspace: "/workspace/harness-code",
    }
    const compact = renderToString(<FullscreenHeader {...props} width={40} />, { columns: 40 })
    const standard = renderToString(<FullscreenHeader {...props} width={72} />, { columns: 72 })
    const wide = renderToString(<FullscreenHeader {...props} width={120} />, { columns: 120 })

    expect(lines(compact)).toHaveLength(1)
    expect(compact).toContain("Harness")
    expect(compact).toContain("BUILD")
    expect(compact).not.toContain("enterprise-model")
    expect(standard).toContain("enterprise-model")
    expect(standard).toContain("thread-12")
    expect(standard).not.toContain("/workspace/harness-code")
    expect(wide).toContain("/workspace/harness-code")
  })
})

describe("FullscreenWelcome", () => {
  it("shows runtime context and no more than three real entry hints", () => {
    const output = renderToString(
      <FullscreenWelcome
        version="0.1.0"
        workspace="/workspace/harness-code"
        model="enterprise-model"
        workMode="compose"
      />,
      { columns: 72 },
    )

    expect(output).toContain("Harness Code 0.1.0")
    expect(output).toContain("/workspace/harness-code")
    expect(output).toContain("enterprise-model")
    expect(output).toContain("直接输入问题或任务开始")
    expect(output).toContain("输入 / 唤起本地命令菜单")
    expect(output).toContain("输入 @ 引用工作区文件或代码片段")
    expect(output.match(/· (直接输入|输入 \/|输入 @)/g)).toHaveLength(3)
    expect(output).not.toContain("Feed")
  })
})

describe("FullscreenFooter", () => {
  it("keeps only essential status in compact mode and adds secondary context when wide", () => {
    const props = {
      activity: "等待输入",
      approvalMode: "default",
      inputMode: "chat" as const,
      connection: "open",
    }
    const compact = renderToString(<FullscreenFooter {...props} width={40} />, { columns: 40 })
    const wide = renderToString(<FullscreenFooter {...props} width={120} />, { columns: 120 })

    expect(lines(compact)).toHaveLength(1)
    expect(compact).toContain("default")
    expect(compact).not.toContain("chat")
    expect(compact).not.toContain("open")
    expect(wide).toContain("default")
    expect(wide).toContain("Shift+Tab")
    expect(wide).toContain("Enter 发送")
    expect(wide).not.toContain("chat")
    expect(wide).not.toContain("open")
  })
})

describe("FullscreenInputBar", () => {
  it("renders a bounded framed draft without repeating header context", () => {
    const output = renderToString(
      <FullscreenInputBar
        draft={"0\n1\n2\n3\n4\n5\n6"}
        draftCursor={13}
        width={40}
        workMode="build"
      />,
      { columns: 40 },
    )

    expect(lines(output).length).toBeLessThanOrEqual(6)
    expect(output).not.toContain("BUILD")
    expect(output).not.toContain("CHAT")
    expect(output).not.toContain("/workspace/harness-code")
    expect(output).toContain("❯")
    expect(output).toContain("╭")
    expect(output).toContain("╮")
    expect(output).toContain("╰")
    expect(output).toContain("╯")
  })

  it("keeps the cursor-end window visible for a long Unicode line", () => {
    const draft = `${"a".repeat(60)}中`
    const output = renderToString(
      <FullscreenInputBar
        draft={draft}
        draftCursor={draft.length}
        width={40}
        workMode="build"
      />,
      { columns: 40 },
    )

    expect(output).toContain("中")
    expect(lines(output).length).toBeLessThanOrEqual(6)
  })
})

describe("ToastViewport", () => {
  it("owns one stable row and includes a semantic glyph with the latest toast", () => {
    const empty = renderToString(<ToastViewport toasts={[]} width={72} />, { columns: 72 })
    const active = renderToString(
      <ToastViewport toasts={[{ id: "toast-1", message: "保存完成", variant: "success" }]} width={72} />,
      { columns: 72 },
    )

    expect(empty).toBe("")
    expect(TOAST_VIEWPORT_ROWS).toBe(1)
    expect(lines(active)).toHaveLength(1)
    expect(active).toContain("✓")
    expect(active).toContain("保存完成")
  })
})

describe("Ink theme ownership", () => {
  it("does not scatter raw semantic color names across production components", () => {
    const baseDir = existsSync(join(process.cwd(), "packages/cli/src/tui/ink"))
      ? join(process.cwd(), "packages/cli/src/tui/ink")
      : join(process.cwd(), "src/tui/ink")
    const files = ["app.tsx", "bottom-area.tsx", "fullscreen-shell.tsx", "menus.tsx", "temporary-view.tsx"]
    for (const file of files) {
      const source = readFileSync(join(baseDir, file), "utf8")
      expect(source, file).not.toMatch(/(?:color|borderColor)="(?:red|green|yellow|cyan|magenta|gray)"/)
    }
  })
})

describe("compact full-screen shell", () => {
  it("keeps welcome context, input, and activity visible in a 40x12 terminal", () => {
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft=""
        terminalWidth={40}
        terminalHeight={12}
        workMode="compose"
        header={<FullscreenHeader width={40} threadId={null} workMode="compose" model="enterprise-model" workspace="/workspace/harness-code" />}
        emptyState={<FullscreenWelcome version="0.1.0" workspace="/workspace/harness-code" model="enterprise-model" workMode="compose" />}
        toast={<ToastViewport toasts={[]} width={40} />}
        status={<FullscreenFooter width={40} activity="等待输入" approvalMode="default" inputMode="chat" connection="open" />}
      />,
      { columns: 40 },
    )

    expect(lines(output)).toHaveLength(12)
    expect(output).toContain("Harness")
    expect(output).toContain("Harness Code 0.1.0")
    expect(output).toContain("❯")
    expect(output).toContain("default")
  })

  it("renders stable frames without overflow across the 40/72/120 x 12/17/24 size matrix", () => {
    const timeline = [
      {
        type: "message" as const,
        message: { id: "m1", role: "user" as const, content: "你好，请检查超长文件路径 /workspace/deep/nested/sub/path/to/very_long_file_name_spec.test.ts 并在终端执行 🚀" },
      },
      {
        type: "message" as const,
        message: { id: "m2", role: "assistant" as const, content: "收到。包含中文、emoji ✨ 和组合字符的大段说明正文，排版应当在视口内自适应换行，不产生溢出或负数宽度。" },
      },
    ]

    const matrix = [
      { columns: 40, rows: 12 },
      { columns: 40, rows: 17 },
      { columns: 40, rows: 24 },
      { columns: 72, rows: 12 },
      { columns: 72, rows: 17 },
      { columns: 72, rows: 24 },
      { columns: 120, rows: 12 },
      { columns: 120, rows: 17 },
      { columns: 120, rows: 24 },
    ]

    for (const size of matrix) {
      const output = renderToString(
        <FullscreenConversationView
          committed={timeline}
          live={[]}
          draft="多行草稿第一行\n多行草稿第二行"
          terminalWidth={size.columns}
          terminalHeight={size.rows}
          workMode="build"
          header={<FullscreenHeader width={size.columns} threadId="thread-abc" workMode="build" model="gpt-4" workspace="/ws" />}
          toast={<ToastViewport toasts={[]} width={size.columns} />}
          status={<FullscreenFooter width={size.columns} activity="就绪" approvalMode="default" inputMode="chat" connection="open" />}
          unseenCount={3}
        />,
        { columns: size.columns },
      )

      const renderedLines = lines(output)
      expect(renderedLines.length, `size ${size.columns}x${size.rows}`).toBeLessThanOrEqual(size.rows)
      expect(output).toContain("Harness")
      expect(output).toContain("↓ 3 条新内容")
    }
  })

  it("renders too-small warning cleanly when terminal dimensions are below 40x12", () => {
    const tooNarrow = renderToString(
      <FullscreenConversationView committed={[]} live={[]} draft="" terminalWidth={39} terminalHeight={20} />,
      { columns: 39 },
    )
    const tooShort = renderToString(
      <FullscreenConversationView committed={[]} live={[]} draft="" terminalWidth={80} terminalHeight={11} />,
      { columns: 80 },
    )

    expect(tooNarrow).toContain("终端过小")
    expect(tooShort).toContain("终端过小")
  })
})

function lines(output: string): string[] {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line, index, all) => !(index === all.length - 1 && line === ""))
}
