/**
 * 「发布到 Project…」弹窗（对齐方案 B 原型与 HC-239 Spec）：
 * - 汇总当前账号所加入全部团队下的活跃 Project 作为可选目标；
 * - 选择项目并确认后，共享全部已有已完成历史及后续定稿；
 * - 提交范围固定，大小限制按现有上传器提示，错误与忙碌反馈保持可见。
 */
import { useEffect, useMemo, useState } from "react"
import type { ReactElement } from "react"
import { IconAlertTriangle, IconX } from "@tabler/icons-react"
import type { ProjectSummary } from "@workbench/collaboration-client/types"
import type {
  LocalConversationRecord,
  LocalConversationTurn,
  OrganizationHost,
} from "../../../shared/index.js"
import { organizationMessage } from "../project-navigation/organization-errors.js"
import {
  buildDefaultPublishBrief,
  inspectPublishHistory,
  resolvePublishTargets,
  type PublishTargetOption,
} from "./personal-sessions-model.js"

export type PublishConversationSubmitInput = {
  readonly workspaceId: string
  readonly projectId: string
  readonly projectName: string
  readonly shareMode: "full"
  readonly historyFromTurnIndex: 0
  readonly initialBrief: string
}

export type PublishConversationDialogProps = {
  readonly organization: OrganizationHost
  readonly record: LocalConversationRecord
  readonly turns: readonly LocalConversationTurn[]
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  readonly defaultProjectId?: string | null
  readonly onClose: () => void
  readonly onPublish: (input: PublishConversationSubmitInput) => Promise<string | null>
}

export function PublishConversationDialog({
  organization,
  record,
  turns,
  workspaces,
  defaultProjectId,
  onClose,
  onPublish,
}: PublishConversationDialogProps): ReactElement {
  const [loadingTargets, setLoadingTargets] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [targets, setTargets] = useState<readonly PublishTargetOption[]>([])
  const [selectedTargetKey, setSelectedTargetKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState("")

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { returnTo?.focus() }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (workspaces.length === 0) {
      setTargets([])
      setLoadingTargets(false)
      return
    }

    setLoadingTargets(true)
    setLoadError("")
    void Promise.all(
      workspaces.map(async ws => {
        const res = await organization.listProjects(ws.id)
        return { ws, res }
      }),
    ).then(results => {
      if (cancelled) return
      const loadedWorkspaces: { workspaceId: string; workspaceName: string; projects: readonly ProjectSummary[] }[] = []
      let firstFailure = ""
      for (const { ws, res } of results) {
        if (res.ok) {
          loadedWorkspaces.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            projects: res.value.projects,
          })
        } else if (!firstFailure) {
          firstFailure = organizationMessage(res.error)
        }
      }
      const resolved = resolvePublishTargets(loadedWorkspaces)
      setTargets(resolved)
      const preferred = (defaultProjectId && resolved.find(item => item.project.projectId === defaultProjectId))
        ?? resolved[0]
      setSelectedTargetKey(preferred ? `${preferred.workspaceId}::${preferred.project.projectId}` : "")
      if (resolved.length === 0 && firstFailure) {
        setLoadError(firstFailure)
      }
      setLoadingTargets(false)
    }).catch(() => {
      if (!cancelled) {
        setLoadError("读取可发布项目列表失败，请重试。")
        setLoadingTargets(false)
      }
    })
    return () => { cancelled = true }
  }, [organization, workspaces, defaultProjectId])

  const selectedTarget = useMemo(
    () => targets.find(item => `${item.workspaceId}::${item.project.projectId}` === selectedTargetKey) ?? null,
    [targets, selectedTargetKey],
  )

  const history = useMemo(() => inspectPublishHistory(turns), [turns])

  async function submit() {
    if (busy) return
    setSubmitError("")
    if (!selectedTarget) {
      setSubmitError("请选择要发布到的活跃项目。")
      return
    }
    setBusy(true)
    const err = await onPublish({
      workspaceId: selectedTarget.workspaceId,
      projectId: selectedTarget.project.projectId,
      projectName: selectedTarget.project.name,
      shareMode: "full",
      historyFromTurnIndex: 0,
      initialBrief: history.completedTurns.length > 0 ? buildDefaultPublishBrief(record, turns).trim() : "",
    }).catch(() => "发布到项目失败，请重试。")
    setBusy(false)
    if (err) {
      setSubmitError(err)
    } else {
      onClose()
    }
  }

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}
      onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose() } }}
    >
      <form
        className="dlg pnav-dialog psess-publish-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlgPublishTitle"
        noValidate
        onSubmit={event => { event.preventDefault(); void submit() }}
      >
        <div className="dlg-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h2 id="dlgPublishTitle">发布到项目</h2>
            <p className="dlg-sub">{record.title || "未命名会话"}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            disabled={busy}
            style={{ marginLeft: "auto" }}
            onClick={onClose}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="dlg-body">
          <p className="psess-dlg-lead">
            将已有已完成对话和后续定稿共享给项目成员，成员按需同步正文；已同步内容无法收回。
          </p>

          <div className="fld">
            <label htmlFor="shareTargetProject">目标项目</label>
            {loadingTargets ? (
              <p className="help" role="status">正在读取可发布项目…</p>
            ) : targets.length === 0 ? (
              <p className="err" role="status">{loadError || "当前没有可发布到的活跃项目，请先新建或加入项目。"}</p>
            ) : (
              <select
                id="shareTargetProject"
                value={selectedTargetKey}
                disabled={busy}
                onChange={event => setSelectedTargetKey(event.target.value)}
              >
                {targets.map(item => {
                  const key = `${item.workspaceId}::${item.project.projectId}`
                  return (
                    <option key={key} value={key}>
                      {workspaces.length > 1
                        ? `${item.project.name} · ${item.workspaceName}`
                        : item.project.name}
                    </option>
                  )
                })}
              </select>
            )}
          </div>

          <p className="help">
            当前共 {history.completedTurns.length} 轮已完成对话，将按现有大小限制分批上传。本机草稿、自动材料与本机记忆不上传。
          </p>
          {history.oversizedDisplayIndices.length > 0 && (
            <div className="psess-warn-box" role="alert">
              <IconAlertTriangle size={14} aria-hidden="true" />
              <span>
                第 {history.oversizedDisplayIndices.join("、")} 轮存在超过单条 32 KiB 上限的内容，将被自动跳过，其余未超限轮次正常上传。
              </span>
            </div>
          )}
        </div>

        {/* 提交反馈与按钮一起保留，避免长正文将失败原因藏到滚动区下方。 */}
        <div className="psess-publish-actions">
          {submitError && <p className="err" role="alert">{submitError}</p>}

          <div className="dlg-foot">
            <span className="spacer" />
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>取消</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || loadingTargets || !selectedTarget}
            >
              {busy ? "正在发布…" : "确认发布"}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
