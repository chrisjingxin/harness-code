/**
 * ACP Web 桥的帧门禁：入站 WebSocket 帧校验、出站子进程 stdout 行切分、stderr 尾部脱敏。
 *
 * 【这是做什么的？】
 * 桥在浏览器与 `harness acp` 子进程之间只做转发，不理解 ACP 内容，但必须保证
 * "一帧一条 JSON-RPC 对象、一条 JSON 一行"的形状不变量，否则协议流会被污染。
 * 本模块是形状门禁的唯一实现（Bun 的 `maxPayloadLength` 只是第一道防线，见设计 F10）。
 *
 * 【上下游】
 * 上游：`bridge.ts` 的 `message`（入站帧）、子进程 stdout `data`（LineSplitter）、
 * stderr `data`（TailBuffer + redactTail 生成崩溃通知）。
 * 下游：`@za38/protocol` 的 `MAX_FRAME_BYTES`（与 v3 stdio 同一个 8 MiB 上限）。
 */

export { MAX_FRAME_BYTES } from "@za38/protocol"

import { MAX_FRAME_BYTES as MAX_FRAME_BYTES_VALUE } from "@za38/protocol"

const encoder = new TextEncoder()

export type InboundFrameResult =
  | { ok: true; line: string }
  | {
      ok: false
      closeCode: 1003 | 1008 | 1009
      reason: "binary-frame" | "frame-too-large" | "newline-in-frame" | "empty-frame" | "not-an-object"
    }

/**
 * 浏览器 → 子进程方向的帧门禁：一帧 = 一条 JSON-RPC 对象。
 *
 * 检查顺序固定（先便宜的后贵的）：非字符串 → 字节超限 → 含换行 → 空 → 非对象。
 * 大小按 UTF-8 字节数算而不是字符数：多字节字符会让 `length` 严重低估真实大小。
 * 这里只查形状不 `JSON.parse`：帧内容（含 ACP 方法名与参数）原样透传，
 * 桥不知道也不应该知道协议细节。
 */
export function checkInboundFrame(data: unknown, maxBytes: number = MAX_FRAME_BYTES_VALUE): InboundFrameResult {
  if (typeof data !== "string") {
    return { ok: false, closeCode: 1003, reason: "binary-frame" }
  }
  if (encoder.encode(data).byteLength > maxBytes) {
    return { ok: false, closeCode: 1009, reason: "frame-too-large" }
  }
  if (data.includes("\n") || data.includes("\r")) {
    return { ok: false, closeCode: 1008, reason: "newline-in-frame" }
  }
  const trimmed = data.trim()
  if (trimmed.length === 0) {
    return { ok: false, closeCode: 1008, reason: "empty-frame" }
  }
  if (trimmed[0] !== "{") {
    return { ok: false, closeCode: 1008, reason: "not-an-object" }
  }
  return { ok: true, line: data }
}

export type OutboundLine =
  | { kind: "line"; text: string }
  | { kind: "error"; closeCode: 1009 | 1011; reason: "frame-too-large" | "bad-utf8" | "non-frame-line" }

/**
 * 子进程 stdout 字节流 → 完整 JSON 行。
 *
 * 按 0x0A 切分；多字节字符可能跨块，所以只在整行到齐后才解码（`fatal: true`
 * 检出非法 UTF-8）。首字节不是 `{` 的行按协议污染处理：Python 侧 stdout 洁癖
 * 保证只有 ACP 帧，出现非帧行说明有东西坏了，桥会关闭连接而不是把垃圾转给浏览器。
 * 单行超过上限时在换行到达之前就报错，缓冲不会无限增长。
 */
export class LineSplitter {
  // 不合并缓冲：pending 是已确认无换行的分块列表，只在新 chunk 里找换行，
  // 遇到换行才拼接整行。8 MiB 单行按 64 KiB 分块到达时，总拷贝量是 O(n)
  // 而不是 O(n²/64K)。
  private chunks: Uint8Array[] = []
  private pendingBytes = 0
  private failed = false
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })

  constructor(private readonly maxLineBytes: number = MAX_FRAME_BYTES_VALUE) {}

  push(chunk: Uint8Array): OutboundLine[] {
    if (this.failed) return []
    const results: OutboundLine[] = []
    let start = 0
    for (;;) {
      let newline = -1
      for (let index = start; index < chunk.length; index += 1) {
        if (chunk[index] === 0x0a) {
          newline = index
          break
        }
      }
      if (newline < 0) {
        // 没有换行：残余已超上限就立刻报错，不等换行（防止缓冲无限增长）。
        if (this.pendingBytes + chunk.length - start > this.maxLineBytes) {
          return this.fail(results, { kind: "error", closeCode: 1009, reason: "frame-too-large" })
        }
        if (start < chunk.length) {
          this.chunks.push(chunk.subarray(start))
          this.pendingBytes += chunk.length - start
        }
        return results
      }
      const lineLength = this.pendingBytes + newline - start
      if (lineLength > this.maxLineBytes) {
        return this.fail(results, { kind: "error", closeCode: 1009, reason: "frame-too-large" })
      }
      const lineBytes = new Uint8Array(lineLength)
      let offset = 0
      for (const piece of this.chunks) {
        lineBytes.set(piece, offset)
        offset += piece.length
      }
      lineBytes.set(chunk.subarray(start, newline), offset)
      this.chunks = []
      this.pendingBytes = 0
      // 行尾 \r 是 \r\n 行尾的残余，剥掉；空行跳过。
      const body = lineBytes[lineBytes.length - 1] === 0x0d
        ? lineBytes.subarray(0, lineBytes.length - 1)
        : lineBytes
      if (body.length > 0) {
        // 首字节不是 {：非帧行，按协议污染处理（1011），不转发。
        if (body[0] !== 0x7b) {
          return this.fail(results, { kind: "error", closeCode: 1011, reason: "non-frame-line" })
        }
        let text: string
        try {
          text = this.decoder.decode(body)
        } catch {
          return this.fail(results, { kind: "error", closeCode: 1011, reason: "bad-utf8" })
        }
        results.push({ kind: "line", text })
      }
      start = newline + 1
    }
  }

  /** 子进程退出时调用：返回被丢弃的残余字节数（非零意味着半截帧）。 */
  end(): number {
    const residual = this.pendingBytes
    this.chunks = []
    this.pendingBytes = 0
    return residual
  }

  /** 出错即失效：桥随后会关闭连接，splitter 不再产出任何内容。 */
  private fail(results: OutboundLine[], error: OutboundLine): OutboundLine[] {
    this.failed = true
    this.chunks = []
    this.pendingBytes = 0
    results.push(error)
    return results
  }
}

/**
 * stderr 尾部缓冲：以字符串形式保留最后 `maxChars` 个字符。
 * 按字符串截断而不是按字节，多字节字符跨块时不会切出乱码。
 */
export class TailBuffer {
  private text = ""
  private readonly decoder = new TextDecoder("utf-8")

  constructor(private readonly maxChars: number = 4_096) {}

  push(chunk: Uint8Array | string): void {
    // 字节输入用 stream 模式解码：多字节字符被切在块边界时留到下一整块再解。
    this.text += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true })
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars)
    }
  }

  tail(chars?: number): string {
    const limit = chars ?? this.maxChars
    return this.text.slice(Math.max(0, this.text.length - limit))
  }
}

/** 连续 32 个及以上 base64url/十六进制形态的字符按秘密处理（hex ⊂ base64url 字符集）。 */
const SECRET_PATTERN = /[A-Za-z0-9_-]{32,}/g
/** 控制字符（含 \n \r \t）一律折成空格，保证尾部是单行可读文本。 */
const CONTROL_PATTERN = /[\x00-\x1f\x7f]+/g

/**
 * 崩溃通知里的 stderr 尾部脱敏：折控制字符 → 替换秘密形态的长串 → 截尾。
 * 先脱敏后截断：如果先截，跨在边界的秘密会留下低于阈值却仍是秘密片段的残段。
 */
export function redactTail(text: string, maxChars = 200): string {
  const cleaned = text.replace(CONTROL_PATTERN, " ").replace(SECRET_PATTERN, "[redacted]")
  return cleaned.slice(Math.max(0, cleaned.length - maxChars))
}
