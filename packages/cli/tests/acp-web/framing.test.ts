/** framing.ts 用例：入站帧门禁、出站按行切分、stderr 尾部脱敏。 */

import { describe, expect, test } from "bun:test"

import {
  LineSplitter,
  MAX_FRAME_BYTES,
  TailBuffer,
  checkInboundFrame,
  redactTail,
} from "../../src/acp-web/bridge/framing"

describe("checkInboundFrame", () => {
  test("合法帧原样返回", () => {
    expect(checkInboundFrame('{"jsonrpc":"2.0","id":1,"method":"x"}')).toEqual({
      ok: true,
      line: '{"jsonrpc":"2.0","id":1,"method":"x"}',
    })
    expect(checkInboundFrame('  {"a":1}  ')).toEqual({ ok: true, line: '  {"a":1}  ' })
  })

  test.each([
    Buffer.from("{}"),
    new ArrayBuffer(2),
    new Uint8Array([123, 125]),
    42,
    null,
    undefined,
  ])("非字符串帧 %j → 1003 binary-frame", data => {
    expect(checkInboundFrame(data)).toEqual({ ok: false, closeCode: 1003, reason: "binary-frame" })
  })

  test("恰好 8 MiB 通过，8 MiB + 1 字节 → 1009", () => {
    const filler = "a".repeat(MAX_FRAME_BYTES - 2)
    expect(checkInboundFrame(`{${filler}}`)).toEqual({ ok: true, line: `{${filler}}` })
    const oversized = "a".repeat(MAX_FRAME_BYTES - 1)
    expect(checkInboundFrame(`{${oversized}}`)).toEqual({
      ok: false,
      closeCode: 1009,
      reason: "frame-too-large",
    })
  })

  test("多字节字符按字节数算上限，不按字符数", () => {
    // 2_796_203 个 "你" = 8_388_609 字节 > 8 MiB，但字符数远小于 8 MiB。
    const oversized = `{${"你".repeat(2_796_203)}}`
    expect(oversized.length).toBeLessThan(MAX_FRAME_BYTES)
    expect(checkInboundFrame(oversized)).toEqual({
      ok: false,
      closeCode: 1009,
      reason: "frame-too-large",
    })
  })

  test.each([
    '{"a":1}\n{}',
    '{"a":1}\r',
    '{\n}',
  ])("含换行 → 1008 newline-in-frame", data => {
    expect(checkInboundFrame(data)).toEqual({ ok: false, closeCode: 1008, reason: "newline-in-frame" })
  })

  test.each(["", "   ", " \t "])("空帧或纯空白 → 1008 empty-frame", data => {
    expect(checkInboundFrame(data)).toEqual({ ok: false, closeCode: 1008, reason: "empty-frame" })
  })

  test.each(["[1,2]", '"x"', "123", "true", "null"])("非对象帧 %j → 1008 not-an-object", data => {
    expect(checkInboundFrame(data)).toEqual({ ok: false, closeCode: 1008, reason: "not-an-object" })
  })

  test("检查顺序：超限帧优先于换行与非对象判定", () => {
    const oversized = `${"a".repeat(MAX_FRAME_BYTES)}\n`
    expect(checkInboundFrame(oversized)).toEqual({
      ok: false,
      closeCode: 1009,
      reason: "frame-too-large",
    })
  })
})

describe("LineSplitter", () => {
  test("8 MiB-1 的单行按 64 KiB 分 128 块到达：一次通过且 < 500 ms", () => {
    const splitter = new LineSplitter()
    const line = "{" + "a".repeat(MAX_FRAME_BYTES - 2)
    const bytes = new TextEncoder().encode(`${line}\n`)
    expect(bytes.length).toBe(MAX_FRAME_BYTES)
    const start = performance.now()
    let results: OutboundLine[] = []
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      results = results.concat(splitter.push(bytes.subarray(offset, offset + 64 * 1024)))
    }
    const elapsed = performance.now() - start
    const lines = results.filter(item => item.kind === "line")
    expect(lines).toHaveLength(1)
    expect(lines[0]!.kind === "line" && lines[0].text).toBe(line)
    expect(elapsed).toBeLessThan(500)
  })

  test("一块数据多行 → 按行输出", () => {
    const splitter = new LineSplitter()
    const result = splitter.push(new TextEncoder().encode('{"a":1}\n{"b":2}\n'))
    expect(result).toEqual([
      { kind: "line", text: '{"a":1}' },
      { kind: "line", text: '{"b":2}' },
    ])
  })

  test("一行分多块 → 拼齐后输出", () => {
    const splitter = new LineSplitter()
    expect(splitter.push(new TextEncoder().encode('{"json'))).toEqual([])
    expect(splitter.push(new TextEncoder().encode('rpc":"2.0"}'))).toEqual([])
    expect(splitter.push(new TextEncoder().encode("\n"))).toEqual([
      { kind: "line", text: '{"jsonrpc":"2.0"}' },
    ])
  })

  test("多字节字符被切在块边界：逐字节喂入仍输出完整行", () => {
    const splitter = new LineSplitter()
    const frame = '{"text":"你好"}'
    const bytes = new TextEncoder().encode(`${frame}\n`)
    for (const byte of bytes) {
      const out = splitter.push(new Uint8Array([byte]))
      if (out.length === 0) continue
      expect(out).toEqual([{ kind: "line", text: frame }])
    }
    expect(splitter.end()).toBe(0)
  })

  test("行尾 \\r 去掉；空行跳过", () => {
    const splitter = new LineSplitter()
    const result = splitter.push(new TextEncoder().encode('{"a":1}\r\n\n{"b":2}\n'))
    expect(result).toEqual([
      { kind: "line", text: '{"a":1}' },
      { kind: "line", text: '{"b":2}' },
    ])
  })

  test("最后一行没换行 → end() 返回残余字节数", () => {
    const splitter = new LineSplitter()
    splitter.push(new TextEncoder().encode('{"a":1}\n{"b":2}'))
    expect(splitter.end()).toBe(7) // {"b":2} 共 7 字节被丢弃
    expect(splitter.end()).toBe(0)
  })

  test("单行超限：换行到达之前就报 frame-too-large，不会无限增长", () => {
    const splitter = new LineSplitter(16)
    const result = splitter.push(new TextEncoder().encode("{".repeat(17)))
    expect(result).toEqual([{ kind: "error", closeCode: 1009, reason: "frame-too-large" }])
    // 失败后 splitter 不再产出内容
    expect(splitter.push(new TextEncoder().encode("{}\n"))).toEqual([])
  })

  test("整行超限（换行在行尾）：同样 frame-too-large", () => {
    const splitter = new LineSplitter(8)
    const result = splitter.push(new TextEncoder().encode('{"a":1234}\n'))
    expect(result).toEqual([{ kind: "error", closeCode: 1009, reason: "frame-too-large" }])
  })

  test("非法 UTF-8 → bad-utf8", () => {
    const splitter = new LineSplitter()
    const result = splitter.push(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a])) // {\xff\xfe}\n
    expect(result).toEqual([{ kind: "error", closeCode: 1011, reason: "bad-utf8" }])
  })

  test("首字符不是 { 的行 → non-frame-line（协议污染，不转发）", () => {
    const splitter = new LineSplitter()
    const result = splitter.push(new TextEncoder().encode("not json\n"))
    expect(result).toEqual([{ kind: "error", closeCode: 1011, reason: "non-frame-line" }])
  })

  test("非帧行之前的合法行先被交付", () => {
    const splitter = new LineSplitter()
    const result = splitter.push(new TextEncoder().encode('{"ok":1}\npolluted\n'))
    expect(result).toEqual([
      { kind: "line", text: '{"ok":1}' },
      { kind: "error", closeCode: 1011, reason: "non-frame-line" },
    ])
  })
})

describe("TailBuffer", () => {
  test("只保留最后 N 个字符", () => {
    const tail = new TailBuffer(5)
    tail.push("hello")
    tail.push(" world!")
    expect(tail.tail()).toBe("orld!")
    expect(tail.tail(3)).toBe("ld!")
  })

  test("字节输入跨块的多字节字符不产生乱码", () => {
    const tail = new TailBuffer(10)
    const bytes = new TextEncoder().encode("a你b")
    tail.push(bytes.subarray(0, 2)) // "a" + "你" 的第 1 字节
    tail.push(bytes.subarray(2))    // "你" 的剩余字节 + "b"
    expect(tail.tail()).toBe("a你b")
  })
})

describe("redactTail", () => {
  test("控制字符与换行折成空格", () => {
    expect(redactTail("line1\nline2\x07end")).toBe("line1 line2 end")
    expect(redactTail("a\rb\tc")).toBe("a b c")
  })

  test("连续 32 个及以上 base64url/十六进制字符替换为 [redacted]", () => {
    const secret = "a".repeat(32)
    expect(redactTail(`prefix ${secret} suffix`)).toBe("prefix [redacted] suffix")
    const hex = "0123456789abcdef".repeat(4) // 64 位十六进制
    expect(redactTail(`x ${hex} y`)).toBe("x [redacted] y")
    // 31 个字符不触发
    expect(redactTail("a".repeat(31))).toBe("a".repeat(31))
  })

  test("含 bootCode 形态的串被替换", () => {
    const bootCodeLike = "Ab3_-Xy9".repeat(6).slice(0, 43) // 43 字符 base64url 形态
    const output = redactTail(`boot failed ${bootCodeLike} end`)
    expect(output).not.toContain(bootCodeLike)
    expect(output).toContain("[redacted]")
  })

  test("截到 200 字符，保留尾部", () => {
    // 用 30 字符段加空格隔开，避免整体被当成一个 base64url 长串而脱敏。
    const long = `start ${`${"x".repeat(30)} `.repeat(10)}end`
    const output = redactTail(long)
    expect(output.length).toBe(200)
    expect(output.endsWith("end")).toBe(true)
    expect(output.startsWith("start")).toBe(false)
  })
})
