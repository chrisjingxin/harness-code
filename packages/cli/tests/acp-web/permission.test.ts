/** permission.ts 表驱动用例（设计 §6.4）：approval/trust 录制帧 + 合成帧。 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { buildInteractionRequest, mapInteractionResponse, type PermissionInput } from "../../src/acp-web/client/permission"

const ctx = { coreThreadId: "core-t1", coreRunId: "core-r1" }

function wireRequest(name: string): PermissionInput {
  const line = readFileSync(join(import.meta.dir, "support/wire", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(l => l.startsWith("{"))
    .map(l => (JSON.parse(l) as { frame: Record<string, unknown> }).frame)
    .find(frame => frame.method === "session/request_permission")!
  return line.params as unknown as PermissionInput
}

describe("buildInteractionRequest：审批信封（approval 录制帧）", () => {
  const input = wireRequest("approval")
  const envelope = buildInteractionRequest(input, ctx)!

  test("request_id / timeout_ms / decisions / description / requests 合成", () => {
    expect(envelope.type).toBe("approval")
    expect(envelope.request_id).toBe("int-1")
    expect(envelope.timeout_ms).toBe(Number.POSITIVE_INFINITY)
    expect(envelope.thread_id).toBe("core-t1")
    expect(envelope.run_id).toBe("core-r1")
    if (envelope.type !== "approval") throw new Error("unreachable")
    expect(envelope.payload.decisions).toEqual(["approve_once", "approve_thread", "approve_project", "reject"])
    expect(envelope.payload.description).toBe("跑一下")
    const requests = envelope.payload.requests as { action_requests: Array<{ name: string; args: unknown; description: string }> }
    expect(requests.action_requests[0]).toEqual({
      name: "execute",
      args: { command: "npm test" },
      description: "跑一下",
    })
  })

  test("registeredToolName 优先于 title 首段", () => {
    const withName = buildInteractionRequest(input, { ...ctx, registeredToolName: "bash" })!
    if (withName.type !== "approval") throw new Error("unreachable")
    const requests = withName.payload.requests as { action_requests: Array<{ name: string }> }
    expect(requests.action_requests[0]!.name).toBe("bash")
  })
})

describe("buildInteractionRequest：presentation", () => {
  const base = wireRequest("approval")
  const withMeta = (presentation: unknown) => ({
    ...base,
    toolCall: { ...base.toolCall, _meta: { harnessCode: { approval: { type: "approval", requestId: "int-9", presentation } } } },
  })

  test("合法 file_diff 透传（snake_case）", () => {
    const envelope = buildInteractionRequest(withMeta({
      kind: "file_diff", operation: "write", path: "/x", unified_diff: "@@", added_lines: 1, removed_lines: 0, truncated: false,
    }), ctx)!
    if (envelope.type !== "approval") throw new Error("unreachable")
    expect(envelope.payload.presentation).toMatchObject({ kind: "file_diff", unified_diff: "@@" })
  })

  test.each([
    { kind: "file_diff", operation: "write", path: "/x", added_lines: 1, removed_lines: 0, truncated: false }, // 缺 unified_diff
    { kind: "file_diff", operation: "rename", path: "/x", unified_diff: "@@", added_lines: 1, removed_lines: 0, truncated: false },
    { kind: "file_diff", operation: "write", path: "/x", unified_diff: "@@", added_lines: "1", removed_lines: 0, truncated: false },
  ])("形状不合法的 presentation 丢弃：%o", presentation => {
    const envelope = buildInteractionRequest(withMeta(presentation), ctx)!
    if (envelope.type !== "approval") throw new Error("unreachable")
    expect(envelope.payload.presentation).toBeUndefined()
  })
})

describe("buildInteractionRequest：rawInput 形状", () => {
  const base = wireRequest("approval")
  const args = (rawInput: unknown) => {
    const envelope = buildInteractionRequest({ ...base, toolCall: { ...base.toolCall, rawInput } }, ctx)!
    if (envelope.type !== "approval") throw new Error("unreachable")
    return (envelope.payload.requests as { action_requests: Array<{ args: unknown }> }).action_requests[0]!.args
  }

  test("对象原样；undefined → {}；字符串 → {value}", () => {
    expect(args({ a: 1 })).toEqual({ a: 1 })
    expect(args(undefined)).toEqual({})
    expect(args("ls -la")).toEqual({ value: "ls -la" })
  })
})

describe("buildInteractionRequest：目录信任（trust 录制帧）", () => {
  const input = wireRequest("trust")
  const envelope = buildInteractionRequest(input, ctx)!

  test("字段映射、access/decisions", () => {
    expect(envelope.type).toBe("directory_trust")
    if (envelope.type !== "directory_trust") throw new Error("unreachable")
    expect(envelope.request_id).toBe("int-1")
    expect(envelope.payload).toMatchObject({
      directory: "/ext",
      target_path: "/ext/a.txt",
      tool_name: "write_file",
      access: "write",
      shadows_workspace: false,
      decisions: ["allow_session", "deny"],
    })
  })

  test("access 非 write → read；shadowsWorkspace 布尔化", () => {
    const modified = {
      ...input,
      toolCall: {
        ...input.toolCall,
        _meta: { harnessCode: { approval: { type: "directory_trust", requestId: "x", access: "execute", shadowsWorkspace: 1 } } },
      },
    }
    const out = buildInteractionRequest(modified, ctx)!
    if (out.type !== "directory_trust") throw new Error("unreachable")
    expect(out.payload.access).toBe("read")
    expect(out.payload.shadows_workspace).toBe(true)
  })
})

describe("mapInteractionResponse：决策映射", () => {
  const input = wireRequest("approval")
  const envelope = buildInteractionRequest(input, ctx)!

  test("approve_once → selected{optionId:'approve_once'}；不在 options 的 decision → cancelled", () => {
    expect(mapInteractionResponse(
      { request_id: "int-1", type: "approval", decision: "approve_once" },
      envelope,
    )).toEqual({ outcome: "selected", optionId: "approve_once" })
    expect(mapInteractionResponse(
      { request_id: "int-1", type: "approval", decision: "reject_with_feedback" },
      envelope,
    )).toEqual({ outcome: "cancelled" })
  })

  test("目录信任 allow_session / deny 直通；type 不匹配 → cancelled", () => {
    const trustReq = buildInteractionRequest(wireRequest("trust"), ctx)!
    expect(mapInteractionResponse({ request_id: "int-1", type: "directory_trust", decision: "allow_session" }, trustReq))
      .toEqual({ outcome: "selected", optionId: "allow_session" })
    expect(mapInteractionResponse({ request_id: "int-1", type: "approval", decision: "approve_once" }, trustReq))
      .toEqual({ outcome: "cancelled" })
  })
})

describe("fail closed：形状不对一律 null（网关回 cancelled）", () => {
  const base = wireRequest("approval")

  test("_meta 缺失 / type 未知 / requestId 缺失 / options 无交集 → null", () => {
    expect(buildInteractionRequest({ ...base, toolCall: { ...base.toolCall, _meta: undefined } }, ctx)).toBeNull()
    expect(buildInteractionRequest({
      ...base,
      toolCall: { ...base.toolCall, _meta: { harnessCode: { approval: { type: "mystery", requestId: "x" } } } },
    }, ctx)).toBeNull()
    expect(buildInteractionRequest({
      ...base,
      toolCall: { ...base.toolCall, _meta: { harnessCode: { approval: { type: "approval" } } } },
    }, ctx)).toBeNull()
    expect(buildInteractionRequest({ ...base, options: [{ optionId: "weird_option" }] }, ctx)).toBeNull()
  })
})

describe("标准 diff 内容块 → file_diff presentation（2.6/2.12）", () => {
  const ctx2 = ctx
  const base: PermissionInput = {
    options: [{ optionId: "approve_once" }, { optionId: "reject" }],
    toolCall: {
      toolCallId: "c1",
      title: "edit a.txt",
      rawInput: {},
      _meta: { harnessCode: { approval: { requestId: "int-9", type: "approval", description: "改文件" } } },
    } as PermissionInput["toolCall"],
  } as PermissionInput
  const pres = (extra: { content?: unknown; meta?: unknown }) => {
    const input = { ...base, toolCall: { ...base.toolCall, content: extra.content, _meta: extra.meta ?? (base.toolCall as { _meta?: unknown })._meta } } as PermissionInput
    const env = buildInteractionRequest(input, ctx2)!
    return (env.payload as unknown as { presentation?: Record<string, unknown> }).presentation
  }

  test("新建（无 oldText）→ write + old_text null", () => {
    const p = pres({ content: [{ type: "diff", path: "/a/new.txt", newText: "l1\nl2\n" }] })!
    expect(p.operation).toBe("write")
    expect(p.old_text).toBeNull()
    expect(p.new_text).toBe("l1\nl2\n")
  })

  test("修改 → edit + diff 含 -/+、公共行不重复", () => {
    const p = pres({ content: [{ type: "diff", path: "/a/x.txt", oldText: "same\nold\nsame2", newText: "same\nnew\nsame2" }] })!
    expect(p.operation).toBe("edit")
    expect(p.unified_diff as string).toContain("-old")
    expect(p.unified_diff as string).toContain("+new")
    expect(p.unified_diff as string).not.toContain("-same")
  })

  test("删除（newText 空串）→ delete + new_text null", () => {
    const p = pres({ content: [{ type: "diff", path: "/a/g.txt", oldText: "gone\n", newText: "" }] })!
    expect(p.operation).toBe("delete")
    expect(p.new_text).toBeNull()
  })

  test("扩展 presentation 存在时优先于标准 diff", () => {
    const ext = { kind: "file_diff", operation: "edit", path: "/ext.txt", unified_diff: "ext", added_lines: 1, removed_lines: 1, truncated: false }
    const p = pres({
      content: [{ type: "diff", path: "/a/x.txt", oldText: "o", newText: "n" }],
      meta: { harnessCode: { approval: { requestId: "int-9", type: "approval", description: "d", presentation: ext } } },
    })!
    expect(p.path).toBe("/ext.txt")
  })

  test("没有 diff 块 → 无 presentation", () => {
    const p = pres({ content: [{ type: "text", text: "plain" }] })
    expect(p).toBeUndefined()
  })

  test("取第一个 diff 块；CRLF/无换行结尾不抛异常", () => {
    const p = pres({ content: [{ type: "text", text: "x" }, { type: "diff", path: "/a/f.txt", oldText: "a\r\nb", newText: "a\r\nc" }] })!
    expect(p.operation).toBe("edit")
    expect(p.path).toBe("/a/f.txt")
  })
})
