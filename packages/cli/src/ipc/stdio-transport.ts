/**
 * 标准输入输出（stdio）行分隔 JSON-RPC 传输通道（StdioRpcTransport）。
 *
 * 【这是做什么的？】
 * 当前端 CLI 启动后台 Python 核心服务后，两者运行在不同进程中，必须通过管道传递数据。
 * 本模块把子进程的写入流（stdin）和读取流（stdout）包装为高级的 JSON 消息通道：
 * 1. 发送（send）：将消息对象转为单行 JSON 并以换行符 `\n` 结尾写入管道，支持背压（缓冲区满时等待 drain）；
 * 2. 接收与按行分帧（onData）：底层流是以任意大小的字节块到达的，一行 JSON 可能被拆碎，本类使用缓冲区按换行符切分为完整的独立消息对象；
 * 3. 安全防护：限制单帧最大字节数，防止异常畸形数据耗尽内存。
 */

import { once } from "node:events"
import { StringDecoder } from "node:string_decoder"
import type { Readable, Writable } from "node:stream"
import { MAX_FRAME_BYTES, type JsonRpcMessage } from "@za38/protocol"
import { AsyncQueue, type RpcTransport } from "./transport"

export class StdioRpcTransport implements RpcTransport {
  private readonly queue = new AsyncQueue<unknown>()
  private readonly decoder = new StringDecoder("utf8")
  private buffer = ""
  private closed = false

  readonly messages: AsyncIterable<unknown> = this.queue

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
    private readonly maxFrameBytes = MAX_FRAME_BYTES,
  ) {
    stdout.on("data", (chunk: Buffer | Uint8Array | string) => this.onData(chunk))
    stdout.on("end", () => this.finish())
    stdout.on("error", error => this.finish(error))
    stdin.on("error", error => this.finish(error))
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("Agent transport is closed")
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      throw new Error(`JSON-RPC frame exceeds ${this.maxFrameBytes} bytes`)
    }
    if (!this.stdin.write(line)) await once(this.stdin, "drain")
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stdin.end()
    this.queue.end()
  }

  private onData(chunk: Buffer | Uint8Array | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk))
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes && !this.buffer.includes("\n")) {
      this.finish(new Error(`JSON-RPC frame exceeds ${this.maxFrameBytes} bytes`))
      return
    }
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        this.finish(new Error(`JSON-RPC frame exceeds ${this.maxFrameBytes} bytes`))
        return
      }
      try {
        this.queue.push(JSON.parse(line))
      } catch {
        // transport 不解释消息语义：非法 JSON 原样入队，由 AgentClient 的统一协议校验报错。
        this.queue.push(line)
      }
    }
  }

  private finish(error?: Error): void {
    if (this.closed) return
    this.closed = true
    if (error) this.queue.fail(error)
    else this.queue.end()
  }
}
