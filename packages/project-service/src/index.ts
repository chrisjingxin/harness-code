/** 独立本机项目服务公开入口。宿主绑定目录，所有后续文件路径均相对该目录。 */
import { ProjectFiles } from "./files.js"
import { ProjectGit } from "./git.js"
import { openRepository } from "./git-state.js"
import { ProjectServiceError } from "./types.js"
import { ProjectRoot } from "./root.js"
import type { ProjectService } from "./types.js"

export const packageId = "@workbench/project-service" as const
export { ProjectServiceError } from "./types.js"
export type {
  ProjectCandidates, ProjectCommitInput, ProjectCommitResult, ProjectDirectory, ProjectEntry, ProjectErrorCode,
  ProjectGitDiff, ProjectGitFile, ProjectGitStatus, ProjectPreview, ProjectPushInput, ProjectPushResult, ProjectService,
} from "./types.js"

/** 仅供受信宿主注入已选项目根。重新登记或切换根时创建新的服务实例。 */
export async function createProjectService(projectRoot: string): Promise<ProjectService> {
  const root = await ProjectRoot.bind(projectRoot)
  let isGitRepository = false
  try {
    await openRepository(root)
    isGitRepository = true
  } catch (error) {
    if (!(error instanceof ProjectServiceError)
      || !["git-unavailable", "git-root-required"].includes(error.code)) throw error
  }
  const files = new ProjectFiles(root, isGitRepository)
  const git = new ProjectGit(root)
  return {
    directoryPath: root.path,
    isGitRepository,
    listDirectory: (directory, cursor) => files.listDirectory(directory, cursor),
    searchCandidates: input => files.searchCandidates(input),
    readPreview: path => files.readPreview(path),
    gitStatus: () => git.status(),
    gitDiff: input => git.diff(input),
    commit: input => git.commit(input),
    push: input => git.push(input),
  }
}
