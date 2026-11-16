/** 在交给 SDK 前限制 stdio 单帧大小。畸形帧关闭连接，避免原始内容进入宿主日志。 */
import { Readable } from "node:stream"
import type { Stream } from "@agentclientprotocol/sdk"

const MAX_FRAME_BYTES = 8 * 1024 * 1024

export function agentStdout(stdout: NodeJS.ReadableStream): Stream["readable"] {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let fragments: Buffer[] = []
  let size = 0
  function append(fragment: Buffer): void {
    size += fragment.length
    if (size > MAX_FRAME_BYTES) throw new Error("Agent 输出帧超过大小限制。")
    if (fragment.length) fragments.push(fragment)
  }

  return Readable.toWeb(Readable.from((async function* () {
    for await (const chunk of stdout) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let start = 0
      for (let index = bytes.indexOf(10, start); index !== -1; index = bytes.indexOf(10, start)) {
        append(bytes.subarray(start, index))
        const text = decoder.decode(Buffer.concat(fragments, size)).trim()
        fragments = []
        size = 0
        start = index + 1
        if (text) {
          const frame: unknown = JSON.parse(text)
          if (!frame || typeof frame !== "object" || !("jsonrpc" in frame) || frame.jsonrpc !== "2.0"
            || (!("method" in frame) && !("id" in frame))) throw new Error("Agent 输出了无效 ACP 帧。")
          yield frame
        }
      }
      append(bytes.subarray(start))
    }
    if (size) throw new Error("Agent 输出的最后一帧未结束。")
  })(), { highWaterMark: 1 })) as Stream["readable"]
}
