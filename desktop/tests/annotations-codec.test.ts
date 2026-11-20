/**
 * HC-237 单元测试：覆盖划选注释编解码往返、规范化截断、斜杠命令保护、源码行号计算与草稿状态更新。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ANNOTATION_BLOCK_HEADER,
  MAX_DRAFT_ANNOTATIONS,
  MAX_DRAFT_ANNOTATION_COMMENT_CHARS,
  MAX_DRAFT_ANNOTATION_SOURCE_CHARS,
  MAX_DRAFT_ANNOTATION_TEXT_CHARS,
  composeAnnotatedPrompt,
  computeLineRangeFromOffsets,
  normalizeAnnotationComment,
  normalizeAnnotationSelectedText,
  normalizeAnnotationSourceLabel,
  parseAnnotatedUserMessage,
} from "../src/ui/conversation/annotations-codec.ts"
import {
  EMPTY_PERSONAL_STATE,
  applyConversationPersonalChange,
} from "../src/renderer/features/session/session-model.ts"

test("0 条注释时原样透传用户正文，不附加前缀或分隔线", () => {
  assert.equal(composeAnnotatedPrompt("普通问题", []), "普通问题")
  assert.equal(composeAnnotatedPrompt("/review", []), "/review")
  assert.equal(parseAnnotatedUserMessage("普通问题"), null)
})

test("单条与多条注释（含来源标签与多行批注）可无损往返编解码", () => {
  const annotations = [
    {
      id: "a1",
      selectedText: "  const x = 1\n\n> 嵌套引用\n---\n1. 所选文本：",
      comment: "这里为什么需要 --- 和空行？\n\n批注：\n  1. 所选文本：",
      sourceLabel: "desktop/src/ui/composer.tsx:L12-L18",
    },
    {
      id: "a2",
      selectedText: "+新增一行\n-删除一行",
      sourceLabel: "desktop/src/ui/composer.tsx (Diff)",
    },
    {
      id: "a3",
      selectedText: "时间线回复摘录",
    },
  ]
  const body = "请帮我对照三处说明，\n\n---\n\n给出修改建议。"
  const composed = composeAnnotatedPrompt(body, annotations)
  const parsed = parseAnnotatedUserMessage(composed)

  assert.ok(parsed)
  assert.equal(parsed.body, body)
  assert.deepEqual(parsed.annotations, [
    {
      selectedText: "  const x = 1\n\n> 嵌套引用\n---\n1. 所选文本：",
      comment: "这里为什么需要 --- 和空行？\n\n批注：\n  1. 所选文本：",
      sourceLabel: "desktop/src/ui/composer.tsx:L12-L18",
    },
    {
      selectedText: "+新增一行\n-删除一行",
      sourceLabel: "desktop/src/ui/composer.tsx (Diff)",
    },
    {
      selectedText: "时间线回复摘录",
    },
  ])
})

test("仅含注释无额外提问正文时可无损编解码", () => {
  const composed = composeAnnotatedPrompt("   \n  ", [
    { id: "a1", selectedText: "只发划选片段", comment: "帮我看下这里" },
  ])
  const parsed = parseAnnotatedUserMessage(composed)
  assert.deepEqual(parsed, {
    annotations: [{ selectedText: "只发划选片段", comment: "帮我看下这里" }],
    body: "",
  })
})

test("斜杠命令保留在首行并将注释后置，往返解码不丢失命令与批注", () => {
  const composed = composeAnnotatedPrompt("/review 检查潜在边界", [
    { id: "a1", selectedText: "if (!ok) return", comment: "补齐错误码", sourceLabel: "src/a.ts:L42" },
  ])
  assert.equal(composed.startsWith("/review 检查潜在边界\n\n---\n\n"), true)
  const parsed = parseAnnotatedUserMessage(composed)
  assert.deepEqual(parsed, {
    annotations: [{ selectedText: "if (!ok) return", comment: "补齐错误码", sourceLabel: "src/a.ts:L42" }],
    body: "/review 检查潜在边界",
  })
})

test("手打或半残伪造格式不会被误解析为结构化注释", () => {
  assert.equal(parseAnnotatedUserMessage(`${ANNOTATION_BLOCK_HEADER}\n\n随便写点文字`), null)
  assert.equal(parseAnnotatedUserMessage(`${ANNOTATION_BLOCK_HEADER}\n\n1. 所选文本：\n没有大于号`), null)
  assert.equal(parseAnnotatedUserMessage(`${ANNOTATION_BLOCK_HEADER}\n\n1. 所选文本：\n> ok\n批注：\n未缩进`), null)
  assert.equal(parseAnnotatedUserMessage(`${ANNOTATION_BLOCK_HEADER}\n\n1. 所选文本：\n> ok\n\n---\n\n   `), null)
  assert.equal(parseAnnotatedUserMessage(`${ANNOTATION_BLOCK_HEADER}\n\n2. 所选文本：\n> 跳号`), null)
})

test("正文、批注与来源标签规范化与长度上限截断", () => {
  assert.equal(normalizeAnnotationSelectedText("  \n \r\n "), null)
  assert.equal(normalizeAnnotationComment(" \n "), null)

  // 保留有效行自身前导缩进，只剥除首尾纯空白行
  assert.deepEqual(normalizeAnnotationSelectedText("\n\n  indented()\n  next()\n\n"), {
    text: "  indented()\n  next()",
    truncated: false,
  })

  const longText = "字".repeat(MAX_DRAFT_ANNOTATION_TEXT_CHARS + 50)
  const trimmedText = normalizeAnnotationSelectedText(longText)
  assert.ok(trimmedText)
  assert.equal(trimmedText.truncated, true)
  assert.equal(trimmedText.text.length, MAX_DRAFT_ANNOTATION_TEXT_CHARS)
  assert.equal(trimmedText.text.endsWith("…"), true)

  const longComment = "评".repeat(MAX_DRAFT_ANNOTATION_COMMENT_CHARS + 20)
  const trimmedComment = normalizeAnnotationComment(longComment)
  assert.ok(trimmedComment)
  assert.equal(trimmedComment.truncated, true)
  assert.equal(trimmedComment.text.length, MAX_DRAFT_ANNOTATION_COMMENT_CHARS)

  // 代理对边界截断不能生成孤立代理
  const emojiText = "😀".repeat(MAX_DRAFT_ANNOTATION_TEXT_CHARS)
  const trimmedEmoji = normalizeAnnotationSelectedText(emojiText)
  assert.ok(trimmedEmoji && trimmedEmoji.text.length <= MAX_DRAFT_ANNOTATION_TEXT_CHARS)
  const lastBeforeEllipsis = trimmedEmoji.text.charCodeAt(trimmedEmoji.text.length - 2)
  assert.equal(lastBeforeEllipsis >= 0xd800 && lastBeforeEllipsis <= 0xdbff, false)

  const label = normalizeAnnotationSourceLabel("  src/测试（主）\n文件.ts  ")
  assert.equal(label, "src/测试（主) 文件.ts")
  const longLabel = normalizeAnnotationSourceLabel("a".repeat(MAX_DRAFT_ANNOTATION_SOURCE_CHARS + 30))
  assert.equal(longLabel?.length, MAX_DRAFT_ANNOTATION_SOURCE_CHARS)
})

test("computeLineRangeFromOffsets 正确计算单行、多行及尾随换行源码行号", () => {
  assert.deepEqual(computeLineRangeFromOffsets("", "first line"), { startLine: 1, endLine: 1 })
  assert.deepEqual(computeLineRangeFromOffsets("line1\n", "line2\n"), { startLine: 2, endLine: 2 })
  assert.deepEqual(computeLineRangeFromOffsets("line1\nline2\n  ", "a\nb\nc\n"), { startLine: 3, endLine: 5 })
  assert.deepEqual(computeLineRangeFromOffsets("a\r\nb\r\n", "c\r\nd"), { startLine: 3, endLine: 4 })
})

test("applyConversationPersonalChange 处理 draft-annotations 上限、修订递增与 clear-draft 重置", () => {
  const many = Array.from({ length: MAX_DRAFT_ANNOTATIONS + 5 }, (_, index) => ({
    id: `id-${index}`,
    selectedText: `文本 ${index}`,
    comment: `批注 ${index}`,
  }))
  const updated = applyConversationPersonalChange(EMPTY_PERSONAL_STATE, {
    kind: "draft-annotations",
    annotations: many,
  })
  assert.equal(updated.draft.revision, 1)
  assert.equal(updated.draft.annotations?.length, MAX_DRAFT_ANNOTATIONS)
  assert.equal(updated.draft.annotations?.[0]?.comment, "批注 0")

  // 旧修订 clear-draft 不应覆盖已更新草稿
  const stale = applyConversationPersonalChange(updated, { kind: "clear-draft", expectedRevision: 0 })
  assert.equal(stale, updated)

  // 匹配修订 clear-draft 原子清空正文与注释
  const cleared = applyConversationPersonalChange(updated, { kind: "clear-draft", expectedRevision: 1 })
  assert.equal(cleared.draft.revision, 2)
  assert.equal(cleared.draft.text, "")
  assert.deepEqual(cleared.draft.annotations, [])
})
