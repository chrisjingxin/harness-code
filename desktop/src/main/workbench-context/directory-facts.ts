/** 只读核对选定目录的 Git 远端；不运行仓库脚本、不联网，不把带口令的地址交给 Agent。 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const run = promisify(execFile)
function publicRemote(raw: string): string | undefined {
  const value = raw.trim()
  if (!value || /[\p{Cc}]/u.test(value)) return
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return
  }
  return value
}
/** 普通非 Git 目录正常返回空事实；Git 地址必须来自当前目录实际配置。 */
export async function directoryGitFacts(path: string): Promise<{ remoteUrl?: string; upstreamUrl?: string }> {
  const read = async (remote: string) => {
    try {
      const result = await run("git", ["-C", path, "config", "--get", `remote.${remote}.url`], { timeout: 2000, maxBuffer: 16 * 1024, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })
      return publicRemote(result.stdout)
    } catch { return undefined }
  }
  const [remoteUrl, upstreamUrl] = await Promise.all([read("origin"), read("upstream")])
  return { ...(remoteUrl ? { remoteUrl } : {}), ...(upstreamUrl ? { upstreamUrl } : {}) }
}
