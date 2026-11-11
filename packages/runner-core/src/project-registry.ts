/**
 * 本地项目登记：原生目录结果 → realpath + dev/ino 指纹；目录被替换或重叠时明确不可用。
 * 云端只看到标识，不接收也不指定本机路径。
 */
import { realpathSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { isAbsolute, relative, sep } from "node:path"
import type { Ledger } from "./ledger.js"

export function rootRef(root: string): string {
  if (!isAbsolute(root)) throw new Error("PROJECT_ROOT_INVALID")
  const real = realpathSync(root)
  const stat = statSync(real)
  if (!stat.isDirectory()) throw new Error("PROJECT_ROOT_INVALID")
  return createHash("sha256").update(`${real}\u0000${stat.dev}\u0000${stat.ino}`).digest("hex")
}

export interface VerifyResult { available: boolean; reason?: "PROJECT_ROOT_CHANGED" | "PROJECT_NOT_SHARED" | "SHARE_VERSION_CHANGED"; root: string }

export class ProjectRegistry {
  readonly #ledger: Ledger
  constructor(ledger: Ledger) { this.#ledger = ledger }

  register(project: { id: string; root: string; name: string; shareEnabled: boolean; shareVersion: string }): void {
    const real = realpathSync(project.root)
    if (this.overlap(real)) throw new Error("PROJECT_ROOT_OVERLAP")
    const reference = rootRef(real)
    this.#ledger.saveProject({ ...project, rootRef: reference, rootPath: real })
  }

  /** 执行前预检：目录必须仍是同一 realpath + dev/ino，否则按闭合原因未调用拒绝。 */
  verify(projectId: string, shareVersion: string): VerifyResult {
    const project = this.#ledger.project(projectId)
    if (!project) return { available: false, reason: "PROJECT_ROOT_CHANGED", root: "" }
    if (!project.shareEnabled) return { available: false, reason: "PROJECT_NOT_SHARED", root: project.rootPath }
    if (project.shareVersion !== shareVersion) return { available: false, reason: "SHARE_VERSION_CHANGED", root: project.rootPath }
    try {
      if (rootRef(project.rootPath) !== project.rootRef) return { available: false, reason: "PROJECT_ROOT_CHANGED", root: project.rootPath }
      return { available: true, root: project.rootPath }
    } catch { return { available: false, reason: "PROJECT_ROOT_CHANGED", root: project.rootPath } }
  }

  /** 只比较已登记的真实路径；同根或父子根都视为重叠，避免同一目录两份执行。 */
  overlap(root: string): boolean {
    const real = realpathSync(root)
    for (const id of this.#ledger.projectIds()) {
      const project = this.#ledger.project(id)
      if (!project) continue
      const other = project.rootPath
      if (other === real || relative(other, real) === "" || relative(real, other) === "") return true
      if (contains(other, real) || contains(real, other)) return true
    }
    return false
  }
}

function contains(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`)
}
