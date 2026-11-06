/**
 * 桥测试用的 `sh -c` 假子进程计划：每个场景返回一份 AcpSpawnPlan。
 *
 * 这些计划只依赖 /bin/sh 与常用工具（cat/yes/trap/sleep），不需要真实 Python，
 * 让回收、背压与崩溃的用例跑得又快又确定。
 */

import type { AcpSpawnPlan } from "../../../src/acp-command"

export type FakeChildScenario = "echo" | "crash" | "ignore-term" | "flood" | "pidfile" | "leak-token" | "pollute" | "sleep" | "stderr-flood" | "crash-with-frame"

/** 把 `sh -c <script>` 包装成 spawn 计划；cwd/env 由调用方覆盖。 */
export function fakeChildPlan(script: string): AcpSpawnPlan {
  return {
    executable: "/bin/sh",
    args: ["-c", script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  }
}

/** 各场景对应的 shell 脚本。 */
export function fakeChild(scenario: FakeChildScenario, options: { pidFile?: string } = {}): AcpSpawnPlan {
  switch (scenario) {
    case "echo":
      // 逐行回显：stdin 读到 EOF 就退出，验证「浏览器关闭 → EOF → 子进程退出」。
      return fakeChildPlan("cat")
    case "crash":
      // 立刻向 stderr 写一行并以 3 退出：验证崩溃通知帧与退出码。
      return fakeChildPlan("echo boom >&2; exit 3")
    case "ignore-term":
      // 屏蔽 SIGTERM 的常驻进程：验证 EOF → SIGTERM → SIGKILL 的升级路径。
      return fakeChildPlan("trap '' TERM; while :; do sleep 0.1; done")
    case "flood":
      // 持续向 stdout 灌合法帧：验证出站背压关闭连接。
      return fakeChildPlan("yes '{\"jsonrpc\":\"2.0\",\"method\":\"x\",\"params\":{}}'")
    case "pidfile":
      // 先写自己的 PID 再 exec cat：测试用文件拿到真实子进程号。
      return fakeChildPlan(`echo $$ > ${options.pidFile}; exec cat`)
    case "leak-token":
      // stderr 输出 40 字符的秘密形态串后退出：验证崩溃通知脱敏。
      return fakeChildPlan("echo aBc9_-Xy7aBc9_-Xy7aBc9_-Xy7aBc9_-Xy7aBc9 >&2; exit 5")
    case "pollute":
      // stdout 输出一行非 JSON：验证协议污染关闭连接。
      return fakeChildPlan("echo 'not json'; sleep 60")
    case "sleep":
      // 不读 stdin 的常驻进程：验证 stdin 背压断开。
      return fakeChildPlan("sleep 60")
    case "crash-with-frame":
      // 写一条完整帧后立即退出：验证"最后的帧 → bridge/exit → 1011"的顺序。
      return fakeChildPlan("echo '{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"last\"}'; exit 3")
    case "stderr-flood":
      // 先向 stderr 写 2 MiB 再回显 stdin：验证 stderr 始终被消费、不阻塞管道。
      return fakeChildPlan("head -c 2097152 /dev/zero | tr '\\0' 'x' >&2; cat")
  }
}
