/**
 * 【功能定义】本机项目只读 Git 入口。
 * 【协作边界】仅提供只读 `status` 与 `diff`，普通非 Git 目录在 `status()` 时平静降级，不提供任何写入操作。
 */
import { inspect, nonGitStatus, openRepository, readDiff } from "./git-state.js"
import { filesystemError, ProjectRoot } from "./root.js"
import { ProjectServiceError } from "./types.js"
import type { ProjectGitDiff, ProjectGitStatus } from "./types.js"

export class ProjectGit {
  constructor(private readonly root: ProjectRoot) {}

  async status(): Promise<ProjectGitStatus> {
    try {
      const repository = await openRepository(this.root)
      if (!repository) return nonGitStatus()
      return (await inspect(repository)).status
    } catch (error) {
      throw filesystemError(error)
    }
  }

  async diff(input: { snapshot: string; path: string }): Promise<ProjectGitDiff> {
    try {
      const repository = await openRepository(this.root)
      if (!repository) {
        throw new ProjectServiceError("git-unavailable", "当前目录不是 Git 仓库，无差异可查看。")
      }
      return await readDiff(repository, input.snapshot, input.path)
    } catch (error) {
      throw filesystemError(error)
    }
  }
}
