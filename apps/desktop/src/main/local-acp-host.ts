/** HC-218 的主进程接点。命令仅从启动配置读取，绑定入口由主进程按账号、设备和目录选择结果授权。 */
import { LocalAcpHost } from "@workbench/acp-runtime"

export function createDesktopLocalAcpHost(env: NodeJS.ProcessEnv = process.env, bindingDirectory?: string): LocalAcpHost {
  const executable = env.WORKBENCH_ACP_EXECUTABLE?.trim()
  if (!executable) return new LocalAcpHost()
  const args: unknown = JSON.parse(env.WORKBENCH_ACP_ARGS_JSON ?? "[]")
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
    throw new Error("WORKBENCH_ACP_ARGS_JSON 必须是字符串数组。")
  }
  return new LocalAcpHost({ executable, args, env }, { bindingDirectory, bindingNamespace: env.WORKBENCH_SERVICE_ORIGIN })
}
