/** Ink InputBar 纯输入缓冲测试。 */
import { describe, expect, it } from "vitest"

import { createInputBuffer, inputBufferReducer, visibleInputLines } from "../../src/tui/ink/input-buffer"

describe("InputBuffer", () => {
  it("inserts at the cursor and normalizes CRLF without submitting", () => {
    const initial = createInputBuffer("ab", 1)
    const next = inputBufferReducer(initial, { type: "insert", text: "中\r\n文" })

    expect(next).toEqual({ value: "a中\n文b", cursor: 4, preferredColumn: undefined })
  })

  it("removes terminal control sequences from pasted text", () => {
    const next = inputBufferReducer(createInputBuffer(), {
      type: "insert",
      text: "\u001b[31mred\u001b[0m\r\nok\u001b]0;title\u0007\u0000\t",
    })

    expect(next.value).toBe("red\nok\t")
  })

  it("moves and deletes only at grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦"
    const value = `A${family}e\u0301中`
    let state = createInputBuffer(value)

    state = inputBufferReducer(state, { type: "left" })
    state = inputBufferReducer(state, { type: "backspace" })
    expect(state.value).toBe(`A${family}中`)
    expect(state.value.slice(0, state.cursor)).toBe(`A${family}`)

    state = inputBufferReducer(state, { type: "backspace" })
    expect(state.value).toBe("A中")
    expect(state.cursor).toBe(1)
  })

  it("snaps the cursor after insertion when adjacent text forms one grapheme", () => {
    const next = inputBufferReducer(createInputBuffer("\u0301", 0), { type: "insert", text: "a" })

    expect(next.value).toBe("a\u0301")
    expect(next.cursor).toBe(2)
  })

  it("keeps Home at the start of an empty first line", () => {
    const next = inputBufferReducer(createInputBuffer("\nabc", 0), { type: "home" })

    expect(next.cursor).toBe(0)
  })

  it("keeps the cursor on a seam when deletion joins adjacent graphemes", () => {
    const value = "a\n\u0301"
    const afterDelete = inputBufferReducer(createInputBuffer(value, 1), { type: "delete" })
    const afterBackspace = inputBufferReducer(createInputBuffer(value, 2), { type: "backspace" })

    expect(afterDelete).toMatchObject({ value: "a\u0301", cursor: 2 })
    expect(afterBackspace).toMatchObject({ value: "a\u0301", cursor: 2 })
  })

  it("moves vertically while preserving the grapheme column", () => {
    let state = createInputBuffer("ab中\nx😀z\nlast", 3)
    state = inputBufferReducer(state, { type: "down" })
    expect(state.cursor).toBe(8)
    state = inputBufferReducer(state, { type: "down" })
    expect(state.cursor).toBe(12)
    state = inputBufferReducer(state, { type: "up" })
    expect(state.cursor).toBe(8)
  })

  it("keeps a six-line window and reports the wide-character cursor column", () => {
    const state = createInputBuffer("0\n1\n2\n3\n4\n5\n中文\n7", "0\n1\n2\n3\n4\n5\n中".length)

    expect(visibleInputLines(state, 6)).toEqual({
      lines: ["1", "2", "3", "4", "5", "中文"],
      firstLine: 1,
      cursorLine: 5,
      cursorColumn: 1,
      cursorDisplayColumn: 2,
    })
  })
})
