/**
 * 「发布到 Project…」弹窗（对齐方案 B 原型与 HC-239 Spec）：
 * - 汇总当前账号所加入全部团队下的活跃 Project 作为可选目标；
 * - 支持选择「完整定稿正文」（可选带入发布前全量或从第 N 轮起的历史，并检查 32 KiB 限制）或「仅共享状态与成果摘要」（自动同步已定稿轮次默认摘要并支持编辑）；
 * - 需显式勾选不可收回确认框后提交。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import { IconAlertTriangle, IconX } from "@tabler/icons-react"
import type { ConversationShareMode, ProjectSummary } from "@workbench/collaboration-client/types"
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
  readonly shareMode: ConversationShareMode
  readonly historyFromTurnIndex?: number
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
  const [shareMode, setShareMode] = useState<ConversationShareMode>("full")
  const [bringHistory, setBringHistory] = useState(false)
  const [fromCompletedRank, setFromCompletedRank] = useState(1)
  const [briefText, setBriefText] = useState(() => buildDefaultPublishBrief(record, turns))
  const briefEditedRef = useRef(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const dialogRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { returnTo?.focus() }
  }, [])

  // 切换目标会话时重置手动编辑标记；turns 异步加载完成后若用户未手改则自动刷新默认摘要。
  useEffect(() => {
    briefEditedRef.current = false
  }, [record.conversationId])

  useEffect(() => {
    if (!briefEditedRef.current) {
      setBriefText(buildDefaultPublishBrief(record, turns))
    }
  }, [record, turns])

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

  const baseInspection = useMemo(() => inspectPublishHistory(turns, 0), [turns])
  const completedTurns = baseInspection.completedTurns
  const selectedStartTurnIndex = useMemo(() => {
    if (!bringHistory || completedTurns.length === 0) return undefined
    const clampedRank = Math.max(1, Math.min(fromCompletedRank, completedTurns.length))
    return completedTurns[clampedRank - 1]?.turnIndex ?? 0
  }, [bringHistory, completedTurns, fromCompletedRank])

  const activeInspection = useMemo(
    () => selectedStartTurnIndex !== undefined ? inspectPublishHistory(turns, selectedStartTurnIndex) : null,
    [turns, selectedStartTurnIndex],
  )

  async function submit() {
    if (busy) return
    setSubmitError("")
    if (!selectedTarget) {
      setSubmitError("请选择要发布到的活跃项目。")
      return
    }
    if (shareMode === "summary_only" && !briefText.trim()) {
      setSubmitError("仅共享摘要时，请填写可展示给队友的状态与成果摘要。")
      return
    }
    if (!confirmed) {
      setSubmitError("请先勾选不可收回共享范围确认。")
      return
    }
    const initialBrief = shareMode === "summary_only"
      ? briefText.trim()
      : (completedTurns.length > 0 ? buildDefaultPublishBrief(record, turns).trim() : "")
    setBusy(true)
    const err = await onPublish({
      workspaceId: selectedTarget.workspaceId,
      projectId: selectedTarget.project.projectId,
      projectName: selectedTarget.project.name,
      shareMode,
      ...(shareMode === "full" && selectedStartTurnIndex !== undefined
        ? { historyFromTurnIndex: selectedStartTurnIndex }
        : {}),
      initialBrief,
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
        ref={dialogRef}
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
            发布后项目成员可见会话简报；已被他人同步的内容无法收回。本机草稿、自动材料与本机记忆绝不上传。
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

          <fieldset className="psess-fieldset">
            <legend>共享档位</legend>
            <label className="psess-radio-card">
              <input
                type="radio"
                name="shareMode"
                value="full"
                checked={shareMode === "full"}
                disabled={busy}
                onChange={() => setShareMode("full")}
              />
              <div>
                <strong>完整定稿正文</strong>
                <p>默认仅同步发布后的新对话；队友可查看简报并按需拉取定稿回复与工具摘要。</p>
              </div>
            </label>
            <label className="psess-radio-card">
              <input
                type="radio"
                name="shareMode"
                value="summary_only"
                checked={shareMode === "summary_only"}
                disabled={busy}
                onChange={() => setShareMode("summary_only")}
              />
              <div>
                <strong>仅共享状态与成果摘要</strong>
                <p>不上传任何历史与后续对话正文，仅在看板和会话卡向队友同步简报与运行状态。</p>
              </div>
            </label>
          </fieldset>

          {shareMode === "full" && completedTurns.length > 0 && (
            <div className="psess-history-box">
              <label className="c4-check">
                <input
                  type="checkbox"
                  checked={bringHistory}
                  disabled={busy}
                  onChange={event => setBringHistory(event.target.checked)}
                />
                <span>一并带入发布前已定稿的历史轮次（共 {completedTurns.length} 轮已完成，默认不同步历史）</span>
              </label>
              {bringHistory && (
                <div className="psess-history-range">
                  <label htmlFor="shareFromTurn">同步范围</label>
                  <select
                    id="shareFromTurn"
                    value={fromCompletedRank}
                    disabled={busy}
                    onChange={event => setFromCompletedRank(Number(event.target.value) || 1)}
                  >
                    <option value={1}>全部已完成轮次（第 1～{completedTurns.length} 轮）</option>
                    {completedTurns.slice(1).map(item => (
                      <option key={item.displayIndex} value={item.displayIndex}>
                        从第 {item.displayIndex} 轮起（共 {completedTurns.length - item.displayIndex + 1} 轮）
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {activeInspection && activeInspection.oversizedDisplayIndices.length > 0 && (
                <div className="psess-warn-box" role="alert">
                  <IconAlertTriangle size={14} aria-hidden="true" />
                  <span>
                    第 {activeInspection.oversizedDisplayIndices.join("、")} 轮存在超过单条 32 KiB 上限的内容，将被自动跳过，其余未超限轮次正常上传。
                  </span>
                </div>
              )}
            </div>
          )}

          {shareMode === "summary_only" && (
            <div className="fld">
              <label htmlFor="shareInitialBrief">状态与成果摘要</label>
              <textarea
                id="shareInitialBrief"
                rows={3}
                maxLength={2000}
                value={briefText}
                disabled={busy}
                placeholder="简述当前进展、结论或交付给队友查看的成果摘要…"
                onChange={event => {
                  briefEditedRef.current = true
                  setBriefText(event.target.value)
                }}
              />
            </div>
          )}

          <label className="c4-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={event => { setConfirmed(event.target.checked); setSubmitError("") }}
            />
            <span>
              我确认向目标项目成员共享
              {shareMode === "full" ? "（含后续定稿对话，已同步内容不可收回）" : "（仅状态与成果摘要）"}
            </span>
          </label>

          {submitError && <p className="err" role="alert">{submitError}</p>}
        </div>

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
      </form>
    </div>
  )
}
