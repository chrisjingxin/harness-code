/** HC-183 WP6：验证纯时间线投影、语义文案与只读工具分组边界。 */

import { describe, expect, it } from "vitest"

import type { TimelineItem } from "../../src/interactive/state"
import {
  projectFullscreenTimeline,
  TOOL_EXEC_MAX_LINES,
  type FullscreenEntry,
  type FullscreenProjectionContext,
} from "../../src/tui/ink/fullscreen-projection"

const context: FullscreenProjectionContext = {
  columns: 72,
  fallbackWorkMode: "build",
}

function tool(
  id: string,
  name: string,
  status: "running" | "completed" | "failed" = "completed",
  scope: Partial<{ runId: string; executionId: string; activityId: string }> = {},
  output = "",
): TimelineItem {
  return {
    type: "tool",
    tool: {
      id,
      runId: scope.runId ?? "run-1",
      name,
      arguments: JSON.stringify({ file_path: `/workspace/${id}.ts`, pattern: id, command: `echo ${id}` }),
      output,
      status,
      executionId: scope.executionId,
      activityId: scope.activityId,
      childExecutionId: name === "task" ? `child-${id}` : undefined,
    },
  }
}

function findByKind<K extends FullscreenEntry["kind"]>(entries: readonly FullscreenEntry[], kind: K) {
  return entries.filter((entry): entry is Extract<FullscreenEntry, { kind: K }> => entry.kind === kind)
}

describe("projectFullscreenTimeline", () => {
  it("projects every timeline kind with stable semantic text and no internal labels", () => {
    const entries = projectFullscreenTimeline([
      { type: "message", message: { id: "u1", role: "user", content: "请读取文件", workMode: "compose" } },
      { type: "message", message: { id: "a1", role: "assistant", content: "# 已完成\n\n**结果**", streaming: true } },
      { type: "reasoning", reasoning: { id: "r1", runId: "run-1", text: "正在思考", active: true } },
      tool("t1", "execute", "running"),
      { type: "interaction", interaction: { id: "i1", runId: "run-1", type: "approval", status: "approved", description: "允许写入" } },
      {
        type: "compose-summary",
        summary: {
          id: "s1",
          runId: "run-1",
          status: "passed",
          text: "已完成实现",
          composeScope: { activityId: "activity-1", stage: "implement", attempt: 1 },
        },
      },
      {
        type: "goal-evaluation",
        evaluation: {
          id: "g1",
          runId: "run-1",
          phase: "result",
          iteration: 1,
          result: "satisfied",
          graderProfileId: "default",
        },
      },
    ], context)

    expect(entries.map(entry => entry.kind)).toEqual([
      "user",
      "assistant",
      "reasoning",
      "tool",
      "interaction-result",
      "compose-summary",
      "goal-evaluation",
    ])
    expect(entries.every(entry => !/You:|Harness:|Reasoning:|Tool:|Interaction:|Goal evaluation:/.test(entry.text))).toBe(true)
    expect(findByKind(entries, "user")[0]?.text).toBe("请读取文件")
    expect(findByKind(entries, "user")[0]?.workMode).toBe("compose")
    expect(findByKind(entries, "assistant")[0]?.text).toContain("已完成")
    expect(findByKind(entries, "assistant")[0]?.spinnerGlyph).toBe("⠋")
    expect(findByKind(entries, "interaction-result")[0]?.statusLabel).toBe("已允许")
    expect(findByKind(entries, "compose-summary")[0]?.statusLabel).toBe("已通过")
    expect(findByKind(entries, "goal-evaluation")[0]?.text).toContain("验收通过")
  })

  it("bounds active reasoning, collapses inactive reasoning, and only animates active entries", () => {
    const source = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n")
    const entries = projectFullscreenTimeline([
      { type: "reasoning", reasoning: { id: "active", runId: "r", text: source, active: true } },
      { type: "reasoning", reasoning: { id: "done", runId: "r", text: "已完成的思考\n隐藏正文", active: false } },
    ], { ...context, spinnerGlyph: "◌" })

    const [active, inactive] = findByKind(entries, "reasoning")
    expect(active?.text).toBe(source)
    expect(active?.lineCount).toBe(30)
    expect(active?.spinnerGlyph).toBe("◌")
    expect(active?.statusLabel).toBe("正在思考")
    expect(inactive?.collapsed).toBe(true)
    expect(inactive?.text).toBe("已完成的思考")
    expect(inactive?.lineCount).toBe(2)
    expect(inactive?.spinnerGlyph).toBeUndefined()
  })

  it("filters only the current pending interaction and does not mutate input", () => {
    const timeline: TimelineItem[] = [
      { type: "interaction", interaction: { id: "pending", runId: "r", type: "question", status: "pending", question: "继续？" } },
      { type: "interaction", interaction: { id: "resolved", runId: "r", type: "question", status: "answered", question: "继续？" } },
    ]
    const before = structuredClone(timeline)
    const entries = projectFullscreenTimeline(timeline, { ...context, pendingInteractionId: "pending" })

    expect(entries.map(entry => entry.id)).toEqual(["interaction:r:resolved"])
    expect(timeline).toEqual(before)
  })

  it("groups only consecutive completed read tools in the same activity", () => {
    const timeline: TimelineItem[] = [
      tool("read-1", "read_file", "completed", { executionId: "exec", activityId: "activity" }),
      tool("grep-1", "grep", "completed", { executionId: "exec", activityId: "activity" }),
      tool("ls-1", "ls", "completed", { executionId: "exec", activityId: "activity" }),
      { type: "message", message: { id: "break", role: "assistant", content: "中间消息" } },
      tool("glob-1", "glob", "completed", { executionId: "exec", activityId: "activity" }),
      tool("glob-2", "glob", "completed", { executionId: "exec", activityId: "other" }),
    ]
    const entries = projectFullscreenTimeline(timeline, context)
    const groups = findByKind(entries, "tool-group")
    const tools = findByKind(entries, "tool")

    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe("tool:run-1:exec:activity:read-1")
    expect(groups[0]?.sourceToolIds).toEqual(["read-1", "grep-1", "ls-1"])
    expect(groups[0]?.sourceEntryIds).toEqual([
      "tool:run-1:exec:activity:read-1",
      "tool:run-1:exec:activity:grep-1",
      "tool:run-1:exec:activity:ls-1",
    ])
    expect(groups[0]?.count).toBe(3)
    expect(tools.map(entry => entry.toolId)).toEqual(["glob-1", "glob-2"])
  })

  it("keeps singletons, mutations, active/failing and unknown tools independent", () => {
    const timeline: TimelineItem[] = [
      tool("single", "read_file"),
      tool("write", "write_file"),
      tool("edit", "edit_file"),
      tool("delete", "delete_file"),
      tool("execute", "execute"),
      tool("task", "task"),
      tool("running", "grep", "running"),
      tool("failed", "grep", "failed"),
      tool("unknown", "mcp__github__create_issue"),
    ]
    const entries = projectFullscreenTimeline(timeline, context)
    const tools = findByKind(entries, "tool")

    expect(findByKind(entries, "tool-group")).toHaveLength(0)
    expect(tools.map(entry => entry.toolId)).toEqual([
      "single", "write", "edit", "delete", "execute", "task", "running", "failed", "unknown",
    ])
    expect(tools.find(entry => entry.toolId === "task")?.childExecutionId).toBe("child-task")
    expect(tools.find(entry => entry.toolId === "running")?.spinnerGlyph).toBe("⠋")
    expect(tools.find(entry => entry.toolId === "failed")?.spinnerGlyph).toBeUndefined()
    expect(tools.find(entry => entry.toolId === "unknown")?.statusLabel).toBe("已完成")
  })

  it("keeps nested tool output bounded and marks status with glyph and Chinese text", () => {
    const output = Array.from({ length: 20 }, (_, index) => `output-${index}`).join("\n")
    const [entry] = projectFullscreenTimeline([tool("out", "execute", "failed", {}, output)], context)

    expect(entry?.kind).toBe("tool")
    if (entry?.kind !== "tool") return
    expect(entry.statusLabel).toBe("失败")
    expect(entry.glyph).toBe("×")
    expect(entry.details.join("\n").split("\n").length).toBeLessThanOrEqual(TOOL_EXEC_MAX_LINES + 1)
    expect(entry.details.some(line => line.startsWith("│ "))).toBe(true)
  })

  it("uses fallback mode and stable ids across repeated projections", () => {
    const timeline: TimelineItem[] = [
      { type: "message", message: { id: "u", role: "user", content: "hello" } },
      tool("a", "read_file"),
      tool("b", "read_file"),
    ]
    const first = projectFullscreenTimeline(timeline, { ...context, fallbackWorkMode: "compose" })
    const second = projectFullscreenTimeline(timeline, { ...context, fallbackWorkMode: "compose" })

    expect(first).toEqual(second)
    expect(findByKind(first, "user")[0]?.workMode).toBe("compose")
    expect(first.map(entry => entry.id)).toEqual([
      "message:u",
      "tool:run-1:root:root:a",
    ])
  })

  it("removes ANSI and terminal control sequences from every untrusted projection field", () => {
    const entries = projectFullscreenTimeline([
      { type: "message", message: { id: "u", role: "user", content: "\u001b]0;owned\u0007用户" } },
      { type: "reasoning", reasoning: { id: "r", runId: "run", text: "\u001b[31m思考\u001b[0m\u009b2J", active: true } },
      tool("unsafe", "execute", "failed", {}, "\u001b[31m失败\u001b[0m\u0007"),
    ], context)
    const serialized = JSON.stringify(entries)

    expect(serialized).not.toContain("\u001b")
    expect(serialized).not.toContain("\u0007")
    expect(serialized).not.toContain("\u009b")
    expect(serialized).toContain("用户")
    expect(serialized).toContain("思考")
    expect(serialized).toContain("失败")
  })

  it("appends waiting activity entry when active and no active tail exists", () => {
    const timeline: TimelineItem[] = [
      { type: "message", message: { id: "u", role: "user", content: "hi" } },
      tool("t1", "execute", "completed"),
    ]
    const entries = projectFullscreenTimeline(timeline, { ...context, active: true })
    const last = entries[entries.length - 1]
    expect(last?.kind).toBe("activity")
    expect(last?.statusLabel).toBe("正在等待响应… · Esc 取消")

    // 当尾部已有活跃条目时（如思考中），不追加 activity 占位
    const withReasoning = projectFullscreenTimeline([
      ...timeline,
      { type: "reasoning", reasoning: { id: "r1", runId: "r", text: "思考中", active: true } },
    ], { ...context, active: true })
    expect(withReasoning.some(e => e.kind === "activity")).toBe(false)
  })

  it("parses structured file tool payloads, generates +/- diffs and chips, and never leaks raw JSON", () => {
    const editItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "edit-1",
        runId: "run-1",
        name: "edit_file",
        arguments: JSON.stringify({
          file_path: "/workspace/test.py",
          old_string: "res.words == 0",
          new_string: "res.words == 7",
        }),
        output: JSON.stringify({
          ok: true,
          path: "/workspace/test.py",
          changed_range: { start_line: 56, end_line: 56, added_lines: 1, removed_lines: 1 },
          total_lines: 132,
          content: "56\tres.words == 7",
        }),
        status: "completed",
      },
    }

    const writeItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "write-1",
        runId: "run-1",
        name: "write_file",
        arguments: JSON.stringify({
          file_path: "/workspace/new.py",
          content: "#!/usr/bin/env python3\nimport sys\n",
        }),
        output: JSON.stringify({
          ok: true,
          path: "/workspace/new.py",
          total_lines: 211,
          line_count: 211,
          changed_range: { start_line: 1, end_line: 211, added_lines: 211, removed_lines: 0 },
        }),
        status: "completed",
      },
    }

    const readItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "read-1",
        runId: "run-1",
        name: "read_file",
        arguments: JSON.stringify({ file_path: "/workspace/test.py" }),
        output: JSON.stringify({
          ok: true,
          path: "/workspace/test.py",
          shown_lines: { start_line: 46, end_line: 75 },
          total_lines: 132,
          content: "46\tdef test_run():\n47\t    pass",
        }),
        status: "completed",
      },
    }

    const failedItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "fail-1",
        runId: "run-1",
        name: "edit_file",
        arguments: JSON.stringify({ file_path: "/workspace/test.py" }),
        output: JSON.stringify({
          ok: false,
          error: { code: "EXACT_MATCH_NOT_FOUND", message: "原文本未匹配" },
        }),
        status: "failed",
      },
    }

    const executeItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "exec-1",
        runId: "run-1",
        name: "execute",
        arguments: JSON.stringify({ command: "pytest -v" }),
        output: "test session starts\npassed",
        status: "completed",
      },
    }

    const entries = projectFullscreenTimeline([editItem, writeItem, readItem, failedItem, executeItem], context)
    const [editEntry, writeEntry, readEntry, failEntry, execEntry] = findByKind(entries, "tool")

    expect(editEntry?.text).toContain("[+1 -1]")
    expect(editEntry?.details.some(line => line.includes("- res.words == 0"))).toBe(true)
    expect(editEntry?.details.some(line => line.includes("+ res.words == 7"))).toBe(true)
    expect(editEntry?.details.some(line => line.includes('{"ok"'))).toBe(false)
    expect(editEntry?.tone).toBe("write")

    expect(writeEntry?.text).toContain("[+211 行]")
    expect(writeEntry?.details.some(line => line.includes("+ #!/usr/bin/env python3"))).toBe(true)
    expect(writeEntry?.details.some(line => line.includes('{"ok"'))).toBe(false)
    expect(writeEntry?.tone).toBe("write")

    expect(readEntry?.text).toContain("[30 行]")
    expect(readEntry?.details.some(line => line.includes("def test_run():"))).toBe(true)
    expect(readEntry?.details.some(line => line.includes('{"ok"'))).toBe(false)
    expect(readEntry?.tone).toBe("read")

    expect(failEntry?.details.some(line => line.includes("EXACT_MATCH_NOT_FOUND") && line.includes("原文本未匹配"))).toBe(true)
    expect(failEntry?.details.some(line => line.includes('{"ok"'))).toBe(false)

    expect(execEntry?.tone).toBe("execute")
    expect(execEntry?.details).toEqual(["│ test session starts", "│ passed"])
  })
})
