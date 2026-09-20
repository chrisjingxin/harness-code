/** Ink Interaction 底部面板：与 InputBar 互斥，键盘完成审批/信任/问答。 */
/** @jsxImportSource react */
import { render, renderToString, Text } from "ink"
import React from "react"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"

import { bottomAreaKind } from "../../src/presentation-shared/interaction-policy"
import { InteractionBottomArea } from "../../src/tui/ink/bottom-area"
import { FullscreenConversationView } from "../../src/tui/ink/app"
import { ToastViewport } from "../../src/tui/ink/fullscreen-shell"
import type { InteractiveSnapshot } from "../../src/interactive/types"
import type { TuiAdapter } from "../../src/tui/application/adapter"

const approval = {
  type: "approval" as const,
  requestId: "a1",
  description: "执行命令 rm -rf /tmp/x",
  requests: {},
  presentation: {
    kind: "file_diff" as const,
    operation: "edit" as const,
    path: "src/app.ts",
    added_lines: 1,
    removed_lines: 1,
    truncated: false,
    unified_diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
  },
  decisions: ["approve_once", "reject"] as Array<"approve_once" | "reject">,
  deadlineAtMs: 1,
}

describe("bottomAreaKind", () => {
  it("keeps InputBar unless an Interaction occupies the slot", () => {
    expect(bottomAreaKind(null)).toBe("input")
    expect(bottomAreaKind(approval)).toBe("approval")
  })
})

describe("InteractionBottomArea", () => {
  it("renders approval options and the file diff instead of the InputBar", () => {
    const dispatched: unknown[] = []
    const adapter = { dispatch: async (intent: unknown) => { dispatched.push(intent) } } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = { interaction: approval, workMode: "build" } as InteractiveSnapshot
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft="should not show"
        terminalWidth={72}
        terminalHeight={24}
        hideInput
        footer={<InteractionBottomArea snapshot={snapshot} adapter={adapter} />}
      />,
      { columns: 72 },
    )

    expect(output).toContain("需要审批")
    expect(output).toContain("允许一次")
    expect(output).toContain("src/app.ts")
    expect(output).toContain("+new")
    expect(output).not.toContain("输入消息")
    expect(output).not.toContain("should not show")
  })

  it("keeps approval decisions visible with full history in a 12-row terminal", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        ...approval,
        presentation: {
          ...approval.presentation,
          unified_diff: `+${"x".repeat(300)}`,
        },
      },
      workMode: "build",
    } as InteractiveSnapshot
    const timeline = Array.from({ length: 30 }, (_, index) => ({
      type: "message" as const,
      message: { id: `message-${index}`, role: "assistant" as const, content: `历史 ${index}` },
    }))
    const output = renderToString(
      <FullscreenConversationView
        committed={timeline}
        live={[]}
        draft=""
        terminalWidth={40}
        terminalHeight={12}
        hideInput
        footer={<InteractionBottomArea snapshot={snapshot} adapter={adapter} maxRows={8} />}
        toast={<ToastViewport toasts={[]} width={40} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )

    expect(output).toContain("Harness Code")
    expect(output).toContain("需要审批")
    expect(output).toContain("允许一次")
    expect(output).toContain("拒绝")
    expect(output).toContain("Enter 确认")
    expect(output).toContain("STATUS")
  })

  it("renders directory trust paths and decisions", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "directory_trust",
        requestId: "d1",
        toolName: "read_file",
        access: "read",
        targetPath: "/other/repo/file.ts",
        directory: "/other/repo",
        shadowsWorkspace: true,
        decisions: ["allow_session", "deny"],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const output = renderToString(<InteractionBottomArea snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("目录信任")
    expect(output).toContain("/other/repo")
    expect(output).toContain("允许")
    expect(output).toContain("拒绝")
  })

  it("keeps the workspace-shadow warning and decisions visible in a 40x12 frame", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "directory_trust",
        requestId: "d-compact",
        toolName: "read_file",
        access: "read",
        targetPath: "/other/repo/file.ts",
        directory: "/other/repo",
        shadowsWorkspace: true,
        decisions: ["allow_session", "deny"],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft=""
        terminalWidth={40}
        terminalHeight={12}
        hideInput
        footer={<InteractionBottomArea snapshot={snapshot} adapter={adapter} maxRows={9} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )

    expect(output).toContain("遮蔽主工作区")
    expect(output).toContain("允许")
    expect(output).toContain("拒绝")
    expect(output).toContain("Enter 确认")
    expect(output).toContain("STATUS")
  })

  it("does not append Ink-normalized mouse reports to a custom question answer", async () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "question",
        requestId: "question-1",
        questions: [{ id: "q", question: "请输入答案", header: "", body: "", options: [], multiSelect: false, allowOther: true }],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => { output += chunk.toString() })
    const instance = render(<InteractionBottomArea snapshot={snapshot} adapter={adapter} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))

    stdin.write("\u001b[<64;12;5M")
    stdin.write("\u001b[<64;12;5M")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(output).not.toContain("[<64;12;5M")
  })

  it("keeps long questions, choices, and status inside a 40x12 frame", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "question",
        requestId: "question-long",
        questions: [{
          id: "q",
          question: "很长的问题 ".repeat(40),
          header: "",
          body: "",
          options: [
            { label: "是", value: "yes", description: "确认" },
            { label: "否", value: "no", description: "拒绝" },
          ],
          multiSelect: false,
          allowOther: false,
        }],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft=""
        terminalWidth={40}
        terminalHeight={12}
        hideInput
        footer={<InteractionBottomArea snapshot={snapshot} adapter={adapter} maxRows={9} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )

    expect(output).toContain("是 · 确认")
    expect(output).toContain("否 · 拒绝")
    expect(output).toContain("Enter 确认")
    expect(output).toContain("STATUS")
  })

  it("renders shell command details and side effect warning for shell approval", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "approval",
        requestId: "a-shell",
        description: "执行命令 rm -rf /tmp/test",
        requests: {
          action_requests: [{ name: "execute", args: { command: "rm -rf /tmp/test" } }],
        },
        presentation: null,
        decisions: ["approve_once", "reject"],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const output = renderToString(<InteractionBottomArea snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("需要审批")
    expect(output).toContain("rm -rf /tmp/test")
    expect(output).toContain("副作用")
    expect(output).toContain("允许一次")
    expect(output).toContain("拒绝")
  })

  it("renders plan review panel and keeps decisions visible in 40x12 frame", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "plan",
        requestId: "p1",
        revision: 1,
        hasPlan: true,
        planMarkdown: "## 步骤 1\n重构 TUI 底部面板\n## 步骤 2\n编写测试验证",
        planVirtualPath: "plan.md",
        planDisplayPath: "plan.md",
        decisions: ["approved", "revise", "abandoned"],
        deadlineAtMs: 1,
      },
      workMode: "compose",
    } as InteractiveSnapshot
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft=""
        terminalWidth={40}
        terminalHeight={12}
        hideInput
        footer={<InteractionBottomArea snapshot={snapshot} adapter={adapter} maxRows={9} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )
    expect(output).toContain("审核计划")
    expect(output).toContain("步骤 1")
    expect(output).toContain("批准并开始实现")
    expect(output).toContain("继续打磨")
    expect(output).toContain("放弃计划")
    expect(output).toContain("Enter 确认")
  })

  it("renders goal review panel with objective, criteria, and decisions in 40x12 frame", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "goal",
        requestId: "g1",
        objective: "完成全屏 TUI 交互统一",
        assumptions: [],
        criteria: ["统一 BottomArea 外壳", "支持键盘交互", "响应式适配"],
        decisions: ["accepted", "edited", "rejected", "cancelled"],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft=""
        terminalWidth={40}
        terminalHeight={12}
        hideInput
        footer={<InteractionBottomArea snapshot={snapshot} adapter={adapter} maxRows={9} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )
    expect(output).toContain("审核目标")
    expect(output).toContain("完成全屏 TUI 交互统一")
    expect(output).toContain("统一 BottomArea 外壳")
    expect(output).toContain("接受并开始")
    expect(output).toContain("Enter 确认")
  })

  it("dispatches plan decision on confirm keypress", async () => {
    const dispatched: unknown[] = []
    const adapter = { dispatch: async (intent: unknown) => { dispatched.push(intent) } } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "plan",
        requestId: "p2",
        revision: 1,
        hasPlan: true,
        planMarkdown: "计划正文",
        planVirtualPath: "plan.md",
        planDisplayPath: "plan.md",
        decisions: ["approved", "abandoned"],
        deadlineAtMs: 1,
      },
      workMode: "compose",
    } as InteractiveSnapshot
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    const instance = render(<InteractionBottomArea snapshot={snapshot} adapter={adapter} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))
    stdin.write("\r")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(dispatched).toContainEqual({ type: "plan", decision: "approved", feedback: undefined })
  })

  it("dispatches goal decision on confirm keypress", async () => {
    const dispatched: unknown[] = []
    const adapter = { dispatch: async (intent: unknown) => { dispatched.push(intent) } } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = {
      interaction: {
        type: "goal",
        requestId: "g2",
        objective: "测试目标",
        assumptions: [],
        criteria: ["条件 1"],
        decisions: ["accepted", "cancelled"],
        deadlineAtMs: 1,
      },
      workMode: "build",
    } as InteractiveSnapshot
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    const instance = render(<InteractionBottomArea snapshot={snapshot} adapter={adapter} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))
    stdin.write("\r")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(dispatched).toContainEqual({ type: "goal", response: { decision: "accepted" } })
  })
})
