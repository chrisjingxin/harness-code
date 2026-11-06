/**
 * 孤儿测试的被测进程：起桥、开一个 WebSocket（pidfile 假子进程），打印
 * `READY <port> <bootCode> <childPid>` 后常驻。
 *
 * 测试把它 kill -9，然后断言子进程在 3 秒内消失——证明"桥被杀"时子进程的
 * stdin 管道随之关闭、cat 读到 EOF 自行退出，不留孤儿。
 *
 * 用法：bun tests/acp-web/support/bridge-runner.ts <pidFile>
 */

import { existsSync, readFileSync } from "node:fs"

import { createAcpWebBridge } from "../../../src/acp-web/bridge/bridge"
import { fakeChild } from "./fake-children"

const pidFile = process.argv[2]
if (!pidFile) {
  console.error("usage: bridge-runner <pidFile>")
  process.exit(2)
}

const bridge = createAcpWebBridge({
  cwd: "/tmp",
  agentPlan: () => fakeChild("pidfile", { pidFile }),
  port: 0,
})
const { port, origin } = await bridge.start()
const bootCode = new URL(bridge.bootUrl()).hash.slice(3)

const redeemed = await fetch(`${origin}/acp/boot`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ code: bootCode }),
})
const { wsToken } = await redeemed.json() as { wsToken: string }
const ws = new WebSocket(`${origin.replace("http", "ws")}/acp/ws?t=${wsToken}`, {
  headers: { origin },
} as never)
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true })
  ws.addEventListener("error", () => reject(new Error("ws open failed")), { once: true })
})

// 等子进程写出自己的 PID。
let childPid = ""
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (existsSync(pidFile)) {
    const content = readFileSync(pidFile, "utf8").trim()
    if (content) {
      childPid = content
      break
    }
  }
  await new Promise(resolve => setTimeout(resolve, 50))
}
if (!childPid) {
  console.error("child did not write pid file")
  process.exit(3)
}
console.log(`READY ${port} ${bootCode} ${childPid}`)

// 常驻：测试随后 kill -9 这个进程。
await new Promise(() => undefined)
