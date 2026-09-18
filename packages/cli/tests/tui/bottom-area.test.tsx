/** Ink Interaction 底部面板：与 InputBar 互斥，键盘完成审批/信任/问答。 */
/** @jsxImportSource react */
import { renderToString } from "ink"
import React from "react"
import { describe, expect, it } from "vitest"

import { bottomAreaKind } from "../../src/presentation-shared/interaction-policy"
import { InteractionBottomArea } from "../../src/tui/ink/bottom-area"
import { MinimalConversationView } from "../../src/tui/ink/app"
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
      <MinimalConversationView
        committed={[]}
        live={[]}
        draft="should not show"
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
})
