/** 独立本机只读项目服务公开入口。宿主绑定目录，所有后续文件路径均相对该目录。 */
import { ProjectFiles } from "./files.js"
import { detectGitRoot } from "./git-state.js"
import { ProjectGit } from "./git.js"
import { ProjectRoot } from "./root.js"
import type { ProjectService } from "./types.js"

export { ProjectServiceError } from "./types.js"
export type {
  ProjectCandidates, ProjectDirectory, ProjectEntry, ProjectErrorCode,
  ProjectGitDiff, ProjectGitFile, ProjectGitStatus, ProjectPreview, ProjectService,
} from "./types.js"

/** 仅供受信宿主注入已选项目根。重新登记或切换根时创建新的只读服务实例。 */
export async function createProjectService(projectRoot: string): Promise<ProjectService> {
  const root = await ProjectRoot.bind(projectRoot)
  const gitInfo = await detectGitRoot(root.path)
  const files = new ProjectFiles(root)
  const git = new ProjectGit(root)
  return {
    rootPath: root.path,
    isGitRepository: gitInfo.isGitRepository,
    listDirectory: (directory, cursor) => files.listDirectory(directory, cursor),
    searchCandidates: input => files.searchCandidates(input),
    readPreview: path => files.readPreview(path),
    gitStatus: () => git.status(),
    gitDiff: input => git.diff(input),
  }
}
