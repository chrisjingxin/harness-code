/**
 * Git 视图的受控夹具：记录意图，再异步投影固定结果，不访问 Git、网络或真实项目。
 * 请求按 scope 和用途隔离；权限/设备状态改变或较新请求到来时丢弃过期结果。
 */
import { useRef } from "react"
import type { ProjectActions, ProjectChangesView, ProjectScope } from "@workbench/ui"
import { previewChanges, previewDiff, previewScopeKey } from "./fixtures.js"
import type { PreviewCondition, PreviewGitOutcome, PreviewProject } from "./fixtures.js"

type PreviewUpdate = (scope: ProjectScope, update: (project: PreviewProject) => PreviewProject) => void
type GitActions = Pick<ProjectActions, "refreshChanges" | "readDiff" | "setSelectedChanges" | "setCommitMessage" | "commit" | "push">

/** 状态改变时撤回无权展示的数据，并让未确认写入保持未知。 */
export function restrictPreviewGit(project: PreviewProject, condition: PreviewCondition): ProjectChangesView {
  const changes = project.changes
  if (condition === "denied") return { status: "error", busy: false, message: "无权查看项目变更（受控示例）。" }
  let result = changes.result
  if (changes.busy) {
    result = result?.commit === "succeeded"
      ? { ...result, push: "unknown", message: "状态改变，推送结果待确认（受控示例）。" }
      : { commit: "unknown", push: "unknown", message: "状态改变，提交结果待确认（受控示例）。" }
  }
  return { ...changes, busy: false, result, ...(condition === "offline" && changes.repository ? { freshness: "cached" as const } : {}) }
}

export function usePreviewGit(projects: Readonly<Record<string, PreviewProject>>, updateProject: PreviewUpdate, slowResponse: boolean): {
  actions: GitActions
  invalidate(scope: ProjectScope): void
  changeVersion(scope: ProjectScope): void
  setOutcome(scope: ProjectScope, outcome: PreviewGitOutcome): void
  toggleUpstream(scope: ProjectScope): void
} {
  const requests = useRef(new Map<string, number>())
  const requestKey = (scope: ProjectScope, kind: string) => `${previewScopeKey(scope)}\0git-${kind}`
  const next = (key: string): number => {
    const value = (requests.current.get(key) ?? 0) + 1
    requests.current.set(key, value)
    return value
  }
  // 预留足够时间在真实窗口切换身份域并编辑新草稿，验证迟到结果的归属。
  const delay = slowResponse ? 12000 : 350

  const actions: GitActions = {
    refreshChanges: scope => {
      next(requestKey(scope, "diff"))
      updateProject(scope, project => {
        if (!canRead(project) || project.changes.busy) return project
        const changes = project.changes.repository
          ? { ...project.changes, status: "ready" as const, freshness: "live" as const, diff: undefined, message: "已刷新受控变更。" }
          : { ...previewChanges(scope), message: "已刷新受控变更。" }
        return { ...project, changes, gitAction: "刷新变更意图（受控示例）" }
      })
    },
    readDiff: (scope, snapshot, path) => {
      const key = requestKey(scope, "diff")
      const sequence = next(key)
      updateProject(scope, project => {
        if (!canRead(project) || project.changes.repository?.snapshot !== snapshot) return project
        return { ...project, changes: { ...project.changes, diff: undefined }, gitAction: `查看 Diff 意图：${path}` }
      })
      window.setTimeout(() => {
        if (requests.current.get(key) !== sequence) return
        updateProject(scope, project => {
          const repository = project.changes.repository
          if (!canRead(project) || !repository || repository.snapshot !== snapshot
            || !repository.files.some(file => file.path === path)) return project
          return { ...project, changes: { ...project.changes, diff: { snapshot, path, ...previewDiff(path) } } }
        })
      }, delay)
    },
    setSelectedChanges: (scope, selectedChanges) => updateProject(scope, project => ({ ...project,
      selectionRevision: project.selectionRevision + 1, personal: { ...project.personal, selectedChanges },
      gitAction: `设置选择意图：${selectedChanges.map(item => item.path).join("、") || "无"}`,
    })),
    setCommitMessage: (scope, commitMessage) => updateProject(scope, project => ({ ...project,
      messageRevision: project.messageRevision + 1, personal: { ...project.personal, commitMessage },
    })),
    commit: (scope, input) => {
      const project = projects[previewScopeKey(scope)]
      const repository = project?.changes.repository
      if (!project || project.condition !== "online" || project.changes.busy || !repository
        || repository.snapshot !== input.snapshot || !input.message.trim() || !input.paths.length
        || (input.alsoPush && !repository.upstream)) return
      const selected = project.personal.selectedChanges.filter(item => input.paths.includes(item.path)
        && repository.files.some(file => file.path === item.path && file.version === item.version))
      if (selected.length !== input.paths.length) return
      const selectionRevision = project.selectionRevision
      const messageRevision = project.messageRevision
      const outcome = project.gitOutcome
      const key = requestKey(scope, "write")
      const sequence = next(key)
      updateProject(scope, current => ({ ...current, changes: { ...current.changes, busy: true, result: undefined },
        gitAction: `${input.alsoPush ? "提交并推送" : "提交"}意图：${input.paths.join("、")}；说明：${input.message}` }))
      window.setTimeout(() => {
        if (requests.current.get(key) !== sequence) return
        updateProject(scope, current => {
          const latest = current.changes.repository
          if (current.condition !== "online" || !latest || !current.changes.busy) return current
          if (latest.snapshot !== input.snapshot) return { ...current, changes: { ...current.changes, busy: false,
            result: { commit: "unknown", push: input.alsoPush ? "unknown" : "not-requested", message: "快照已变化，受控提交结果待确认。" } } }
          if (outcome === "commit-failed" || outcome === "commit-unknown") return { ...current, changes: { ...current.changes,
            busy: false, result: { commit: outcome === "commit-failed" ? "failed" : "unknown",
              push: outcome === "commit-unknown" && input.alsoPush ? "unknown" : "not-requested",
              message: outcome === "commit-failed" ? "受控提交失败。" : "受控提交结果待确认。" } } }
          const commitSha = sequence.toString(16).padStart(40, "0")
          const push = !input.alsoPush ? "not-requested" as const : outcome === "push-failed" ? "failed" as const
            : outcome === "push-unknown" ? "unknown" as const : "succeeded" as const
          // 只收尾仍是发起时版本的草稿；用户在途编辑过的内容整体保留。
          const remaining = current.selectionRevision === selectionRevision
            ? current.personal.selectedChanges.filter(item => !selected.some(sent => sent.path === item.path && sent.version === item.version))
            : current.personal.selectedChanges
          const message = current.messageRevision === messageRevision && current.personal.commitMessage === input.message
            ? "" : current.personal.commitMessage
          return { ...current, personal: { ...current.personal, selectedChanges: remaining, commitMessage: message },
            changes: { ...current.changes, busy: false, diff: undefined,
              repository: { ...latest, head: commitSha, snapshot: `${latest.snapshot}:commit-${sequence}` },
              result: { commit: "succeeded", commitSha, push,
                ...(push === "failed" ? { warning: "受控示例：推送失败，已确认的提交仍保留。" } : {}),
                ...(push === "unknown" ? { warning: "受控示例：请先确认推送结果。" } : {}) } } }
        })
      }, delay)
    },
    push: (scope, input) => {
      const project = projects[previewScopeKey(scope)]
      const result = project?.changes.result
      const repository = project?.changes.repository
      if (!project || project.condition !== "online" || project.changes.busy
        || !repository || repository.snapshot !== input.snapshot || repository.head !== input.commitSha
        || !repository.upstream || result?.commit !== "succeeded" || result.commitSha !== input.commitSha
        || result.push === "succeeded" || result.push === "unknown") return
      const key = requestKey(scope, "write")
      const sequence = next(key)
      updateProject(scope, current => ({ ...current, changes: { ...current.changes, busy: true },
        gitAction: `单独推送意图：${input.commitSha}（没有再次提交）` }))
      window.setTimeout(() => {
        if (requests.current.get(key) !== sequence) return
        updateProject(scope, current => {
          const latestResult = current.changes.result
          if (current.condition !== "online" || !current.changes.busy || latestResult?.commit !== "succeeded"
            || latestResult.commitSha !== input.commitSha) return current
          const unchanged = current.changes.repository?.snapshot === input.snapshot && current.changes.repository.head === input.commitSha
          return { ...current, changes: { ...current.changes, busy: false, result: { ...latestResult,
            push: unchanged ? "succeeded" : "unknown", warning: unchanged ? undefined : "目标已变化，推送结果待确认。" } } }
        })
      }, delay)
    },
  }

  return {
    actions,
    invalidate: scope => {
      const prefix = `${previewScopeKey(scope)}\0git-`
      for (const [key, value] of requests.current) if (key.startsWith(prefix)) requests.current.set(key, value + 1)
    },
    changeVersion: scope => updateProject(scope, project => {
      const repository = project.changes.repository
      if (!repository || !canRead(project)) return project
      const path = project.personal.selectedChanges[0]?.path ?? repository.files[0]?.path
      if (!path) return project
      const gitRevision = project.gitRevision + 1
      const files = repository.files.map(file => file.path === path ? { ...file, version: `v${gitRevision}` } : file)
      // 只改变上游列表；是否撤销旧选择通过组件的受控动作观察。
      return { ...project, gitRevision, gitAction: `受控版本变化：${path}`,
        changes: { ...project.changes, diff: undefined, repository: { ...repository, files, snapshot: `${repository.snapshot}:v${gitRevision}` } } }
    }),
    setOutcome: (scope, gitOutcome) => updateProject(scope, project => ({ ...project, gitOutcome })),
    toggleUpstream: scope => updateProject(scope, project => {
      const repository = project.changes.repository
      if (!repository) return project
      return { ...project, changes: { ...project.changes, repository: { ...repository,
        upstream: repository.upstream ? undefined : { remote: "origin", branch: "main", ahead: 1, behind: 0 } } },
        gitAction: repository.upstream ? "受控示例：移除推送目标" : "受控示例：恢复推送目标" }
    }),
  }
}

function canRead(project: PreviewProject): boolean {
  return project.condition === "online" || project.condition === "readonly"
}
