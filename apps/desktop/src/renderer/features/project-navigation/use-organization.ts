/**
 * 组织数据读取：团队 → 项目列表；团队 + 项目 → 详情与成员显示名。
 * 每次请求带递增序号，范围变化或重新读取后，旧请求的结果直接丢弃，避免迟到数据串到另一个项目。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { CollaborationHost, MemberSummary, ProjectDetailResponse, ProjectSummary, RepositorySummary } from "@workbench/contracts"
import type { NavigationAvailability, NavigationMember } from "@workbench/ui"
import type { OrganizationHost } from "../../../organization-host.js"

type Loaded<T> = { value: T; availability: NavigationAvailability }
const failed = (message: string): NavigationAvailability => ({ state: "failed", message })

/** 读取当前账号参与的项目；创建或改名后由调用方重新读取，以服务端返回的角色与成员数为准。 */
export function useProjects(host: OrganizationHost, workspaceId: string, enabled = true) {
  const [state, setState] = useState<Loaded<readonly ProjectSummary[]>>({ value: [], availability: { state: "loading" } })
  const request = useRef(0)
  const load = useCallback(async () => {
    if (!enabled) return
    const current = ++request.current
    setState(previous => ({ ...previous, availability: { state: "loading" } }))
    const result = await host.listProjects(workspaceId).catch(() => null)
    if (current !== request.current) return
    if (!result) setState(previous => ({ ...previous, availability: failed("无法读取项目，请重试。") }))
    else if (!result.ok) setState(previous => ({ ...previous, availability: failed(result.error.message) }))
    else if (result.value.workspaceId !== workspaceId) setState(previous => ({ ...previous, availability: failed("项目列表与当前团队不一致。") }))
    else setState({ value: result.value.projects, availability: { state: "ready" } })
  }, [host, workspaceId, enabled])
  useEffect(() => {
    if (!enabled) return
    void load()
    return () => { request.current++ }
  }, [load, enabled])
  return { projects: state.value, availability: state.availability, reload: load }
}

/** 团队成员只在团队范围内读取一次，供项目成员显示名与添加候选使用。 */
export function useTeamMembers(host: CollaborationHost, workspaceId: string, enabled = true) {
  const [state, setState] = useState<Loaded<readonly MemberSummary[]>>({ value: [], availability: { state: "loading" } })
  const request = useRef(0)
  const load = useCallback(async () => {
    if (!enabled) return
    const current = ++request.current
    const result = await host.listMembers(workspaceId).catch(() => null)
    if (current !== request.current) return
    if (!result?.ok) setState(previous => ({ ...previous, availability: failed(result?.error.message ?? "无法读取团队成员，请重试。") }))
    else setState({ value: result.value.members, availability: { state: "ready" } })
  }, [host, workspaceId, enabled])
  useEffect(() => {
    if (!enabled) return
    void load()
    return () => { request.current++ }
  }, [load, enabled])
  return { members: state.value, availability: state.availability, reload: load }
}

export type ProjectDetailState = {
  detail: ProjectDetailResponse | null
  availability: NavigationAvailability
  /** 服务端返回 RESOURCE_NOT_FOUND：当前账号已不能访问该项目。 */
  lost: boolean
}

/** 读取项目详情；切换项目时立即清空旧详情，绝不把上一个项目的成员显示在新项目下。 */
export function useProjectDetail(host: OrganizationHost, workspaceId: string, projectId: string | null) {
  const [state, setState] = useState<ProjectDetailState & { projectId: string | null }>({ projectId, detail: null, availability: { state: "loading" }, lost: false })
  const request = useRef(0)
  const load = useCallback(async () => {
    const current = ++request.current
    if (!projectId) { setState({ projectId, detail: null, availability: { state: "unavailable" }, lost: false }); return }
    setState(previous => previous.projectId === projectId
      ? { ...previous, availability: { state: "loading" } }
      : { projectId, detail: null, availability: { state: "loading" }, lost: false })
    const result = await host.getProject(workspaceId, projectId).catch(() => null)
    if (current !== request.current) return
    if (!result) setState(previous => ({ ...previous, availability: failed("无法读取项目资料，请重试。") }))
    else if (!result.ok) setState(previous => ({ ...previous, availability: failed(result.error.message), lost: result.error.code === "RESOURCE_NOT_FOUND" }))
    else if (result.value.project.projectId !== projectId || result.value.project.workspaceId !== workspaceId) {
      setState(previous => ({ ...previous, availability: failed("项目资料与当前选择不一致。") }))
    } else setState({ projectId, detail: result.value, availability: { state: "ready" }, lost: false })
  }, [host, workspaceId, projectId])
  useEffect(() => {
    void load()
    return () => { request.current++ }
  }, [load])
  const current = state.projectId === projectId ? state : { detail: null, availability: { state: "loading" } as const, lost: false }
  return { ...current, reload: load }
}

/** 项目成员与团队成员按 userId 合并出显示名；团队名单里找不到的成员用标识前缀兜底。 */
export function projectMembers(detail: ProjectDetailResponse | null, team: readonly MemberSummary[]): NavigationMember[] {
  if (!detail) return []
  const users = new Map(team.map(item => [item.user.id, item.user]))
  return detail.members.map(member => {
    const user = users.get(member.userId)
    return { userId: member.userId, displayName: user?.displayName ?? `成员 ${member.userId.slice(0, 8)}`, username: user?.username ?? "", left: member.status === "removed" }
  })
}

/** 团队仓库目录只在资料页需要时读取。 */
export function useRepositories(host: OrganizationHost, workspaceId: string, enabled: boolean) {
  const [state, setState] = useState<Loaded<readonly RepositorySummary[]>>({ value: [], availability: { state: "loading" } })
  const request = useRef(0)
  const load = useCallback(async () => {
    const current = ++request.current
    const result = await host.listRepositories(workspaceId).catch(() => null)
    if (current !== request.current) return
    if (!result?.ok) setState(previous => ({ ...previous, availability: failed(result?.error.message ?? "无法读取团队仓库，请重试。") }))
    else setState({ value: result.value.repositories, availability: { state: "ready" } })
  }, [host, workspaceId])
  useEffect(() => {
    if (!enabled) return
    void load()
    return () => { request.current++ }
  }, [load, enabled])
  return { repositories: state.value, availability: state.availability, reload: load }
}
