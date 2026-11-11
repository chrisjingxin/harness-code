/** 原设备只读端口装配。项目 ID 在本机账本中解析，读取前后都复核共享和目录。 */
import { createProjectService, ProjectServiceError } from "@workbench/project-service"
import type { ProjectErrorCode } from "@workbench/project-service"
import type { Ledger, ProjectReadOutcome, ProjectReadPort, ProjectRegistry } from "@workbench/runner-core"

type ProjectReadAction = Parameters<ProjectReadPort["read"]>[2]
type ProjectReadFailureCode = Extract<ProjectReadOutcome, { status: "error" }>["code"]
type ProjectReadResponse = Extract<ProjectReadOutcome, { status: "ok" }>["response"]

const errors: Partial<Record<ProjectErrorCode, ProjectReadFailureCode>> = {
  "root-changed": "PROJECT_ROOT_CHANGED", "invalid-path": "PROJECT_PATH_INVALID", "outside-project": "PROJECT_PATH_INVALID",
  "not-found": "PROJECT_FILE_NOT_FOUND", "permission-denied": "PROJECT_FILE_DENIED", "unsupported": "PROJECT_FILE_UNSUPPORTED",
  "binary-file": "PROJECT_FILE_UNSUPPORTED", "unsupported-encoding": "PROJECT_FILE_UNSUPPORTED",
  "file-changed": "PROJECT_FILE_CHANGED", "cursor-expired": "PROJECT_CURSOR_EXPIRED", "limit-exceeded": "PROJECT_LIMIT_EXCEEDED",
  "git-unavailable": "PROJECT_GIT_UNAVAILABLE", "git-root-required": "PROJECT_GIT_ROOT_REQUIRED",
  "git-busy": "PROJECT_BUSY", "git-blocked": "PROJECT_BUSY", "git-stale": "PROJECT_GIT_STALE",
  "invalid-selection": "PROJECT_GIT_STALE",
}

export function createProjectReadPort(registry: ProjectRegistry, ledger: Ledger): ProjectReadPort {
  return {
    async read(projectId, shareVersion, action): Promise<ProjectReadOutcome> {
      const verify = () => {
        const project = registry.verify(projectId, shareVersion)
        if (!project.available) {
          const code: ProjectReadFailureCode = project.reason === "PROJECT_NOT_SHARED" ? "PROJECT_NOT_SHARED"
            : project.reason === "SHARE_VERSION_CHANGED" ? "SHARE_VERSION_CONFLICT" : "PROJECT_ROOT_CHANGED"
          return { code }
        }
        if (ledger.occupied(project.root) !== null) return { code: "PROJECT_BUSY" as const }
        return { root: project.root }
      }
      try {
        const initial = verify()
        if ("code" in initial) return { status: "error", code: initial.code! }
        const service = await createProjectService(initial.root)
        const bound = verify()
        if ("code" in bound) return { status: "error", code: bound.code! }
        if (bound.root !== initial.root) return { status: "error", code: "PROJECT_ROOT_CHANGED" }
        const response = await readAction(service, action)
        const final = verify()
        if ("code" in final) return { status: "error", code: final.code! }
        if (final.root !== initial.root) return { status: "error", code: "PROJECT_ROOT_CHANGED" }
        return { status: "ok", response }
      } catch (error) {
        return { status: "error", code: error instanceof ProjectServiceError ? errors[error.code] ?? "PROJECT_READ_FAILED" : "PROJECT_READ_FAILED" }
      }
    },
  }
}

async function readAction(
  service: Awaited<ReturnType<typeof createProjectService>>, action: ProjectReadAction,
): Promise<ProjectReadResponse> {
  switch (action.kind) {
    case "listDirectory": {
      const value = await service.listDirectory(action.directory, action.cursor)
      return { kind: action.kind, value: { ...value, entries: [...value.entries] } }
    }
    case "searchCandidates": {
      const value = await service.searchCandidates(action)
      return { kind: action.kind, value: { ...value, items: value.items.map(item => ({ ...item, matchRanges: [...item.matchRanges] })) } }
    }
    case "readPreview":
      return { kind: action.kind, value: await service.readPreview(action.path) }
    case "gitStatus": {
      const value = await service.gitStatus()
      return { kind: action.kind, value: { ...value, files: [...value.files] } }
    }
    case "gitDiff":
      return { kind: action.kind, value: await service.gitDiff(action) }
  }
}
