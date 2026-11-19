/**
 * 【功能定义】将服务端的 UTF-8 SSE 字节流转换成已校验的轻量通知事件。续读位置由调用方维护。
 * 【协作边界】纯标准 Web ReadableStream / TextDecoder 解析，零 Electron 依赖。
 */
import type { NotificationEvent } from "./types/index.js"

const MAX_FRAME_LENGTH = 16_384

/** 字节或帧违反通知契约，重连时只能从上个已处理位置继续。 */
export class InvalidProjectNotification extends Error {}

/**
 * 在空行处分发完整帧。断线时丢弃未完成的帧，由服务器从上个已确认位置重发。
 * 心跳注释不产生事件。校验失败会上抛并关闭流，宿主仍使用上个已确认位置。
 */
export async function* readProjectNotifications(
  body: ReadableStream<Uint8Array>,
  isEvent: (value: unknown) => value is NotificationEvent,
): AsyncGenerator<NotificationEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffered = ""
  let frameLength = 0
  let id = ""
  let event = ""
  let data: string[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      try {
        buffered += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      } catch {
        throw new InvalidProjectNotification("通知流不是有效的 UTF-8")
      }
      const breaks = /\r\n|\r|\n/g
      let offset = 0
      for (const match of buffered.matchAll(breaks)) {
        const end = match.index + match[0].length
        // 若块尾是 CR，等下一块确认它是否是 CRLF 的一部分。
        if (!chunk.done && end === buffered.length && match[0] === "\r") break
        const line = buffered.slice(offset, match.index)
        frameLength += end - offset
        offset = end
        if (frameLength > MAX_FRAME_LENGTH) throw new InvalidProjectNotification("通知帧超过大小限制")
        if (line === "") {
          if (data.length > 0) {
            let value: unknown
            try { value = JSON.parse(data.join("\n")) }
            catch { throw new InvalidProjectNotification("通知载荷不是有效的 JSON") }
            if (!isEvent(value) || String(value.id) !== id || value.type !== event) {
              throw new InvalidProjectNotification("通知帧与载荷不一致")
            }
            yield value
          }
          frameLength = 0
          id = ""
          event = ""
          data = []
          continue
        }
        const separator = line.indexOf(":")
        const field = separator < 0 ? line : line.slice(0, separator)
        const argument = separator < 0 ? "" : line.slice(separator + (line[separator + 1] === " " ? 2 : 1))
        if (field === "id") id = argument
        if (field === "event") event = argument
        if (field === "data") data.push(argument)
      }
      buffered = buffered.slice(offset)
      if (buffered.length + frameLength > MAX_FRAME_LENGTH) throw new InvalidProjectNotification("通知帧超过大小限制")
      if (chunk.done) return
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
