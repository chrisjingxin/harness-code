/**
 * 组织数据读取：团队 → 项目列表；团队 + 项目 → 详情与成员显示名。
 * 每次请求带递增序号，范围变化或重新读取后，旧请求的结果直接丢弃，避免迟到数据串到另一个项目。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { CollaborationHost, MemberSummary, ProjectDetailResponse, ProjectSummary, RepositorySummary } from "@workbench/collaboration-client/types"
import type { OrganizationHost } from "../../../shared/index.js"
import type { NavigationAvailability, NavigationMember } from "../../../ui/index.js"
import { resolveUserPhoto } from "../../demo-avatars.js"

type Loaded<T> = { value: T; availability: NavigationAvailability }
const failed = (message: string): NavigationAvailability => ({ state: "failed", message })

/** 读取当前账号参与的项目；创建或改名后由调用方重新读取，以服务端返回的角色与成员数为准。 */
export function useProjects(host: OrganizationHost, workspaceId: string | null, enabled = true) {
  const [state, setState] = useState<Loaded<readonly ProjectSummary[]> & { workspaceId: string | null }>({
    workspaceId,
    value: [],
    availability: workspaceId && enabled ? { state: "loading" } : { state: "unavailable" },
  })
  const request = useRef(0)
  const load = useCallback(async () => {
    if (!enabled || !workspaceId) return
    const targetWorkspaceId = workspaceId
    const current = ++request.current
    setState(previous => previous.workspaceId === targetWorkspaceId
      ? { ...previous, availability: { state: "loading" } }
      : { workspaceId: targetWorkspaceId, value: [], availability: { state: "loading" } })
    const result = await host.listProjects(targetWorkspaceId).catch(() => null)
    if (current !== request.current) return
    if (!result) setState({ workspaceId: targetWorkspaceId, value: [], availability: failed("无法读取项目，请重试。") })
    else if (!result.ok) setState({ workspaceId: targetWorkspaceId, value: [], availability: failed(result.error.message) })
    else if (result.value.workspaceId !== targetWorkspaceId) setState({ workspaceId: targetWorkspaceId, value: [], availability: failed("项目列表与当前团队不一致。") })
    else setState({ workspaceId: targetWorkspaceId, value: result.value.projects, availability: { state: "ready" } })
  }, [host, workspaceId, enabled])
  useEffect(() => {
    if (!workspaceId) {
      request.current++
      setState({ workspaceId: null, value: [], availability: { state: "unavailable" } })
      return
    }
    if (!enabled) return
    void load()
    return () => { request.current++ }
  }, [load, enabled, workspaceId])
  if (!workspaceId) return { projects: [] as readonly ProjectSummary[], availability: { state: "unavailable" } as NavigationAvailability, reload: load }
  const scoped = state.workspaceId === workspaceId
    ? state
    : { value: [] as readonly ProjectSummary[], availability: { state: "loading" } as NavigationAvailability }
  return { projects: scoped.value, availability: scoped.availability, reload: load }
}

/** 团队成员只在团队范围内读取一次，供项目成员显示名与添加候选使用。 */
export function useTeamMembers(host: CollaborationHost, workspaceId: string | null, enabled = true) {
  const [state, setState] = useState<Loaded<readonly MemberSummary[]> & { workspaceId: string | null }>({
    workspaceId,
    value: [],
    availability: workspaceId && enabled ? { state: "loading" } : { state: "unavailable" },
  })
  const request = useRef(0)
  const load = useCallback(async () => {
    if (!enabled || !workspaceId) return
    const targetWorkspaceId = workspaceId
    const current = ++request.current
    setState(previous => previous.workspaceId === targetWorkspaceId
      ? { ...previous, availability: { state: "loading" } }
      : { workspaceId: targetWorkspaceId, value: [], availability: { state: "loading" } })
    const result = await host.listMembers(targetWorkspaceId).catch(() => null)
    if (current !== request.current) return
    if (!result?.ok) setState({ workspaceId: targetWorkspaceId, value: [], availability: failed(result?.error.message ?? "无法读取团队成员，请重试。") })
    else setState({ workspaceId: targetWorkspaceId, value: result.value.members, availability: { state: "ready" } })
  }, [host, workspaceId, enabled])
  useEffect(() => {
    if (!workspaceId) {
      request.current++
      setState({ workspaceId: null, value: [], availability: { state: "unavailable" } })
      return
    }
    if (!enabled) return
    void load()
    return () => { request.current++ }
  }, [load, enabled, workspaceId])
  if (!workspaceId) return { members: [] as readonly MemberSummary[], availability: { state: "unavailable" } as NavigationAvailability, reload: load }
  const scoped = state.workspaceId === workspaceId
    ? state
    : { value: [] as readonly MemberSummary[], availability: { state: "loading" } as NavigationAvailability }
  return { members: scoped.value, availability: scoped.availability, reload: load }
}

export type ProjectDetailState = {
  detail: ProjectDetailResponse | null
  availability: NavigationAvailability
  /** 服务端返回 RESOURCE_NOT_FOUND：当前账号已不能访问该项目。 */
  lost: boolean
}

/** 读取项目详情；切换项目时立即清空旧详情，绝不把上一个项目的成员显示在新项目下。 */
export function useProjectDetail(host: OrganizationHost, workspaceId: string | null, projectId: string | null) {
  const [state, setState] = useState<ProjectDetailState & { workspaceId: string | null; projectId: string | null }>({
    workspaceId,
    projectId,
    detail: null,
    availability: { state: "loading" },
    lost: false,
  })
  const request = useRef(0)
  const load = useCallback(async () => {
    const current = ++request.current
    if (!workspaceId || !projectId) {
      setState({ workspaceId, projectId, detail: null, availability: { state: "unavailable" }, lost: false })
      return
    }
    const targetWorkspaceId = workspaceId
    const targetProjectId = projectId
    setState(previous => previous.workspaceId === targetWorkspaceId && previous.projectId === targetProjectId
      ? { ...previous, availability: { state: "loading" } }
      : { workspaceId: targetWorkspaceId, projectId: targetProjectId, detail: null, availability: { state: "loading" }, lost: false })
    const result = await host.getProject(targetWorkspaceId, targetProjectId).catch(() => null)
    if (current !== request.current) return
    if (!result) setState({ workspaceId: targetWorkspaceId, projectId: targetProjectId, detail: null, availability: failed("无法读取项目资料，请重试。"), lost: false })
    else if (!result.ok) setState({ workspaceId: targetWorkspaceId, projectId: targetProjectId, detail: null, availability: failed(result.error.message), lost: result.error.code === "RESOURCE_NOT_FOUND" })
    else if (result.value.project.projectId !== targetProjectId || result.value.project.workspaceId !== targetWorkspaceId) {
      setState({ workspaceId: targetWorkspaceId, projectId: targetProjectId, detail: null, availability: failed("项目资料与当前选择不一致。"), lost: false })
    } else setState({ workspaceId: targetWorkspaceId, projectId: targetProjectId, detail: result.value, availability: { state: "ready" }, lost: false })
  }, [host, workspaceId, projectId])
  useEffect(() => {
    void load()
    return () => { request.current++ }
  }, [load])
  const current = !workspaceId || !projectId
    ? { detail: null, availability: { state: "unavailable" } as const, lost: false }
    : state.workspaceId === workspaceId && state.projectId === projectId
      ? state
      : { detail: null, availability: { state: "loading" } as const, lost: false }
  return { ...current, reload: load }
}

/** 项目成员与团队成员按 userId 合并出姓名、工号与所属机构；团队名单里找不到的成员用标识前缀兜底。 */
export function projectMembers(detail: ProjectDetailResponse | null, team: readonly MemberSummary[]): NavigationMember[] {
  if (!detail) return []
  const users = new Map(team.map(item => [item.user.id, item.user]))
  const leftUsers = new Set(team.filter(item => item.status === "removed").map(item => item.user.id))
  return detail.members.map(member => {
    const user = users.get(member.userId)
    const fallbackName = `成员 ${member.userId.slice(0, 8)}`
    const photo = resolveUserPhoto(user ?? { userName: fallbackName })
    return {
      userId: member.userId,
      userName: user?.userName ?? fallbackName,
      userNo: user?.userNo ?? "",
      ...(photo ? { photo } : {}),
      ...(user?.orgName ? { orgName: user.orgName } : {}),
      ...(user?.orgPathName ? { orgPathName: user.orgPathName } : {}),
      left: member.status === "removed" || leftUsers.has(member.userId),
    }
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
