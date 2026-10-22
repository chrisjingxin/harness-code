/** write/edit 参数只抽出路径和正文，不把整段 JSON 当展示。 */

import { expect, test } from "bun:test"

import { parseFileDiff } from "../../../src/presentation-shared/file-diff"
import { parseFileMutationArgs, parseToolResultPreview, unifiedDiffFromEdits, unifiedDiffFromReplacement } from "../../../src/tui/presentation/tools/file-mutation-args"

test("从 write_file 参数抽出路径和正文", () => {
  const raw = JSON.stringify({
    file_path: "/examples/python/jsondiff_usage.py",
    content: "print('hello')\nprint('world')\n",
  })
  expect(parseFileMutationArgs(raw)).toEqual({
    path: "/examples/python/jsondiff_usage.py",
    content: "print('hello')\nprint('world')\n",
    edits: null,
  })
})

test("流式未闭合 JSON 也能抽出路径和已到达的正文", () => {
  const raw = '{"file_path":"/examples/python/jsondiff_usage.py","content":"print(\'hello\')\\nprint(\'wo'
  expect(parseFileMutationArgs(raw)).toEqual({
    path: "/examples/python/jsondiff_usage.py",
    content: "print('hello')\nprint('wo",
    edits: null,
  })
})

test("接受 path 字段别名；畸形 JSON 返回空", () => {
  expect(parseFileMutationArgs(JSON.stringify({ path: "src/app.ts", content: "x" }))).toEqual({
    path: "src/app.ts",
    content: "x",
    edits: null,
  })
  expect(parseFileMutationArgs("{not-json")).toEqual({ path: null, content: null, edits: null })
  expect(parseFileMutationArgs("")).toEqual({ path: null, content: null, edits: null })
})

test("从 edit_file 的 edits[] 抽出 old/new，并生成可解析 unified diff", () => {
  const parsed = parseFileMutationArgs(JSON.stringify({
    file_path: "/file-organizer.py",
    snapshot_id: "snap-1",
    edits: [{ old_string: "documents", new_string: "media" }],
  }))
  expect(parsed).toEqual({
    path: "/file-organizer.py",
    content: null,
    edits: [{ oldString: "documents", newString: "media" }],
  })
  const diff = unifiedDiffFromReplacement(parsed.path ?? "file", parsed.edits![0]!.oldString, parsed.edits![0]!.newString)
  expect(parseFileDiff(diff).status).toBe("parsed")
  expect(diff).toContain("-documents")
  expect(diff).toContain("+media")
})

test("多处 edits 生成多段 hunk，起始行依次顺延且整体仍可解析", () => {
  const diff = unifiedDiffFromEdits("/src/app.ts", [
    { oldString: "const a = 1", newString: "const a = 2" },
    { oldString: "x\ny", newString: "x\nz" },
    { oldString: "old", newString: "" },
  ])
  expect(parseFileDiff(diff).status).toBe("parsed")
  expect(diff.match(/^@@ /gm)?.length).toBe(3)
  expect(diff).toContain("-const a = 1")
  expect(diff).toContain("+const a = 2")
  expect(diff).toContain("-y")
  expect(diff).toContain("+z")
  expect(diff).toContain("-old")
})

test("流式未闭合的 edits[] 只展示已经完整到达的项，半截项和半截字符串先不展示", () => {
  const complete = '{"file_path":"/a.ts","snapshot_id":"s","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c\\"q","new_string":"d"},'
  expect(parseFileMutationArgs(complete + '{"old_string":"e","new_str').edits).toEqual([
    { oldString: "a", newString: "b" },
    { oldString: 'c"q', newString: "d" },
  ])
  expect(parseFileMutationArgs('{"file_path":"/a.ts","edits":[{"old_string":"a","new_str').edits).toBeNull()
  expect(parseFileMutationArgs('{"file_path":"/a.ts","edits":[').edits).toBeNull()
  // 字符串里出现的花括号不影响对象边界。
  expect(parseFileMutationArgs('{"edits":[{"old_string":"if (x) {","new_string":"}"},{"old').edits).toEqual([
    { oldString: "if (x) {", newString: "}" },
  ])
})

test("旧的扁平 old_string/new_string 参数不再被识别为编辑", () => {
  const parsed = parseFileMutationArgs(JSON.stringify({ file_path: "/a.ts", old_string: "x", new_string: "y" }))
  expect(parsed.edits).toBeNull()
})

test("从工具结果 JSON 抽出恢复用路径和正文窗口", () => {
  const raw = JSON.stringify({
    ok: true,
    path: "/file-organizer.py",
    snapshot_id: "snap-1",
    content: "    '.csv': 'documents',\n",
  })
  expect(parseToolResultPreview(raw)).toMatchObject({
    path: "/file-organizer.py",
    content: "    '.csv': 'documents',\n",
  })
})
