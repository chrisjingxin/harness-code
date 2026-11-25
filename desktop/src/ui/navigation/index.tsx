/**
 * Project 导航（1:1 还原原型稿左侧边栏）：
 * Workspace 切换 + 团队知识库入口 → Project 切换 + 看板/任务 → + 新建会话 + 搜索按钮(⌘K) → 仅我的会话列表 → 个人栏。
 * 组件不发请求、不持有身份或个人状态；所有意图通过 actions 回传给宿主。
 */
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconBan,
  IconBook,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFolder,
  IconInbox,
  IconLayoutGrid,
  IconListCheck,
  IconLock,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconUpload,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { safeAvatarUrl } from "../common/avatar.js";
import type { NavigationMemberGroup, NavigationSessionEntry } from "./members.js";
import {
  RenameSessionDialog,
  SessionContextMenu,
  type SessionContextMenuItem,
} from "./session-context-menu.js";

export { buildMemberGroups } from "./members.js";
export type {
  MemberGroupInput,
  NavigationMember,
  NavigationMemberGroup,
  NavigationSessionEntry,
} from "./members.js";

/** 各区域的读取状态；failed 表示可重试的失败，denied 表示当前账号无权访问。 */
export type NavigationAvailability = {
  state: "ready" | "loading" | "failed" | "denied" | "unavailable";
  message?: string;
};
/** 左栏可直接打开的页面；任务详情等子页面由宿主映射到所属入口高亮。 */
export type NavigationPageKind = "new" | "conversation" | "board" | "tasks" | "info" | "knowledge";
export type NavigationProjectItem = {
  projectId: string;
  name: string;
  archived: boolean;
  memberCount?: number;
  repo?: string | null;
};
export type NavigationWorkspaceItem = {
  workspaceId: string;
  name: string;
  memberCount?: number;
  projectCount?: number;
  memberPhotos?: readonly { initial: string; photo?: string | null }[];
};
export type NavigationRetryArea = "projects" | "members" | "sessions";

/** 双轨左栏当前激活空间：个人空间（本机优先）或团队空间（Project 协同）。 */
export type NavigationSpaceKind = "personal" | "team";

/** 跨空间顶置「收件箱」入口状态：云端红点角标与本机等待确认计数绝不混算。 */
export type NavigationInboxView = {
  readonly active: boolean;
  readonly cloudActionCount: number;
  readonly localAttentionCount: number;
};

/** 个人空间左栏中的单条本机个人会话索引。 */
export type NavigationPersonalEntry = {
  conversationId: string;
  title: string;
  timeLabel: string;
  status: "idle" | "running" | "waiting_approval" | "error";
  shareStatus: "local_only" | "active" | "stopped";
};

/** 个人空间按本机工程目录聚合的可折叠分组。 */
export type PersonalNavigationDirectoryGroup = {
  directoryKey: string;
  directoryPath: string | null;
  label: string;
  records: readonly NavigationPersonalEntry[];
};

export type ProjectNavigationView = {
  accountName: string | null;
  accountPhoto?: string | null;
  accountRole?: string | null;
  workspaceName: string | null;
  workspaces?: readonly NavigationWorkspaceItem[];
  currentWorkspaceId?: string | null;
  projects: readonly NavigationProjectItem[];
  projectsAvailability: NavigationAvailability;
  currentProjectId: string | null;
  currentProjectRepo?: string | null;
  currentProjectMemberCount?: number | null;
  localDeviceName?: string | null;
  groups: readonly NavigationMemberGroup[];
  membersAvailability: NavigationAvailability;
  sessionsAvailability: NavigationAvailability;
  search: string;
  activePage: NavigationPageKind | null;
  selectedConversationId: string | null;
  /** 任务数量由看板/任务模块提供；为空时不显示数字。 */
  taskCount: number | null;
  /** 团队知识库（Workspace 规约）条数。 */
  knowledgeCount?: number | null;
  /** 双轨工作台当前空间；未传入时退回原有单栏项目导航以兼容组件预览。 */
  activeSpace?: NavigationSpaceKind;
  workspaceRoleLabel?: string | null;
  hasTeamUpdates?: boolean;
  offline?: boolean;
  canPublishPersonal?: boolean;
  personalGroups?: readonly PersonalNavigationDirectoryGroup[];
  personalSearch?: string;
  selectedPersonalConversationId?: string | null;
  landingConversationId?: string | null;
  publishedSessionCount?: number;
  /** 跨空间全局收件箱状态。 */
  inbox?: NavigationInboxView;
};

export type ProjectNavigationActions = {
  selectSpace?(space: NavigationSpaceKind): void;
  selectWorkspace?(workspaceId: string): void;
  selectProject(projectId: string): void;
  createProject(): void;
  openProjectSettings(): void;
  openProjectSettingsFor?(projectId: string): void;
  openPage(kind: "new" | "board" | "tasks" | "knowledge"): void;
  /** 若宿主支持新建会话弹窗，优先触发该函数。 */
  createSession?(): void;
  selectConversation(conversationId: string): void;
  /** 保存失败时返回可显示的原因。 */
  renameConversation?(conversationId: string, title: string): Promise<string | null>;
  createPersonalSession?(): void;
  selectPersonalConversation?(conversationId: string): void;
  renamePersonalConversation?(conversationId: string, title: string): Promise<string | null>;
  publishPersonalConversation?(conversationId: string): void;
  stopSharingConversation?(conversationId: string): void;
  setPersonalSearch?(text: string): void;
  reconnect?(): void;
  openInbox?(): void;
  toggleMember(userId: string): void;
  setSearch(text: string): void;
  openCommandPalette?(): void;
  toggleLeftSidebar?(): void;
  retry(area: NavigationRetryArea): void;
  openSettings(): void;
};

export type ProjectNavigationProps = {
  view: ProjectNavigationView;
  actions: ProjectNavigationActions;
};

const fallback: Record<Exclude<NavigationAvailability["state"], "ready">, string> = {
  loading: "正在加载…",
  failed: "加载失败",
  denied: "当前无权访问",
  unavailable: "尚未接入",
};
const text = (value: NavigationAvailability) =>
  value.state === "ready" ? "" : (value.message ?? fallback[value.state]);

function Status({ value, area, actions }: { value: NavigationAvailability; area: NavigationRetryArea; actions: ProjectNavigationActions }) {
  if (value.state === "ready") return null;
  return (
    <div className="pnav-status" role={value.state === "failed" ? "alert" : "status"}>
      <span>{text(value)}</span>
      {value.state === "failed" && (
        <button type="button" onClick={() => actions.retry(area)}>重试</button>
      )}
    </div>
  );
}

/** 成员圆形头像：支持安全远程链接、站内静态路径及打包内联位图，加载失败自动回退到姓名首字。 */
export function MemberAvatar({
  initial,
  photo,
  self,
  size = 22,
}: {
  initial: string;
  photo?: string | null;
  self?: boolean;
  size?: number;
}): ReactElement {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const candidate = safeAvatarUrl(photo);
  const src = candidate && brokenUrl !== candidate ? candidate : null;
  return (
    <span
      className="pnav-avatar"
      data-self={self ? "true" : "false"}
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {src ? <img className="pnav-avatar-img" src={src} alt="" onError={() => setBrokenUrl(candidate)} /> : initial}
    </span>
  );
}

/** Workspace 切换器：双轨模式渲染原型 .ws-pill-btn 胶囊，传统单栏预览保持成员头像堆叠风格。 */
function WorkspaceSwitch({ view, actions, dualTrack }: ProjectNavigationProps & { dualTrack: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const workspaces = view.workspaces ?? (view.workspaceName
    ? [{ workspaceId: view.currentWorkspaceId ?? "ws-current", name: view.workspaceName }]
    : []);
  const currentWs = workspaces.find((item) => item.workspaceId === view.currentWorkspaceId) ?? workspaces[0];
  const memberAvatars = view.groups.slice(0, 3).map((g) => ({ initial: g.initial, photo: g.photo, self: g.self }));
  const memberCount = currentWs?.memberCount ?? (view.groups.length || null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    root.current?.querySelector<HTMLButtonElement>(".pnav-menu button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (run: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    run();
  };

  return (
    <div className="pnav-switcher" ref={root}>
      {dualTrack ? (
        <button
          ref={trigger}
          type="button"
          className="ws-pill-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!view.workspaceName}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="ws-dot" aria-hidden="true" />
          <span className="ws-pill-name">{view.workspaceName ?? "未选择团队"}</span>
          {view.workspaceRoleLabel && <span className="ws-pill-role">{view.workspaceRoleLabel}</span>}
          <IconChevronDown size={12} className="chev" aria-hidden="true" />
        </button>
      ) : (
        <button
          ref={trigger}
          type="button"
          className="switch-btn pnav-ws-switch"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!view.workspaceName}
          onClick={() => setOpen((value) => !value)}
        >
          {memberAvatars.length > 0 ? (
            <span className="av-stack">
              {memberAvatars.map((m, idx) => (
                <MemberAvatar key={idx} initial={m.initial} photo={m.photo} self={m.self} size={22} />
              ))}
            </span>
          ) : (
            <MemberAvatar initial={(view.workspaceName ?? "W").slice(0, 1)} self size={22} />
          )}
          <span className="switch-txt">
            <span className="switch-name od-truncate">{view.workspaceName ?? "未选择团队"}</span>
            <span className="switch-sub">
              <span className="od-truncate">
                Workspace{memberCount ? ` · ${memberCount} 人` : ""}
              </span>
            </span>
          </span>
          <IconChevronDown size={14} className="chev" aria-hidden="true" />
        </button>
      )}

      {open && workspaces.length > 0 && (
        <div className="pnav-menu" role="menu" aria-label="切换 Workspace">
          <div className="pnav-menu-label">Workspace</div>
          {workspaces.map((ws) => {
            const on = ws.workspaceId === (currentWs?.workspaceId ?? view.currentWorkspaceId);
            const wsPhotos = ws.memberPhotos ?? memberAvatars;
            return (
              <button
                key={ws.workspaceId}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => choose(() => actions.selectWorkspace?.(ws.workspaceId))}
              >
                {wsPhotos.length > 0 && (
                  <span className="av-stack">
                    {wsPhotos.slice(0, 3).map((m, idx) => (
                      <MemberAvatar key={idx} initial={m.initial} photo={m.photo} size={20} />
                    ))}
                  </span>
                )}
                <span className="mi-main">
                  <span className="mi-name">{ws.name}</span>
                  {(ws.memberCount || ws.projectCount) && (
                    <span className="mi-sub">
                      {[ws.memberCount ? `${ws.memberCount} 人` : null, ws.projectCount ? `${ws.projectCount} 个 Project` : null].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                <span className="pnav-menu-check">{on && <IconCheck size={14} aria-hidden="true" />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Project 切换器（项目名称 + 成员数/仓库 + 下拉切换与新建 + 右侧 Project 设置齿轮）。 */
function ProjectSwitch({ view, actions }: ProjectNavigationProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = view.projects.find((item) => item.projectId === view.currentProjectId);
  const availability = view.projectsAvailability;
  const label = current?.name
    ?? (availability.state === "ready" ? (view.projects.length ? "选择项目" : "还没有项目") : text(availability));
  const memberCount = view.currentProjectMemberCount ?? current?.memberCount ?? (view.groups.length || null);
  const repo = view.currentProjectRepo ?? current?.repo;
  const subParts = [
    memberCount ? `${memberCount} 人` : null,
    repo || null,
    current?.archived ? "已归档" : null,
  ].filter(Boolean);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    root.current?.querySelector<HTMLButtonElement>(".pnav-menu button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const choose = (run: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    run();
  };

  return (
    <div className="pnav-project" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="switch-btn pnav-project-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!view.workspaceName}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="switch-txt">
          <span className="switch-name od-truncate" data-placeholder={!current || undefined}>{label}</span>
          {subParts.length > 0 && (
            <span className="switch-sub">
              <span className="od-truncate">{subParts.join(" · ")}</span>
            </span>
          )}
        </span>
        <IconChevronDown size={14} className="chev" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="pnav-icon-button"
        aria-label="项目设置"
        title="Project 设置与成员"
        disabled={!current}
        data-active={view.activePage === "info"}
        onClick={actions.openProjectSettings}
      >
        <IconAdjustmentsHorizontal size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="pnav-menu" role="menu" aria-label="切换 Project">
          <div className="pnav-menu-label">Project</div>
          {availability.state !== "ready" && (
            <div className="pnav-menu-status">
              <span>{text(availability)}</span>
              {availability.state === "failed" && (
                <button type="button" role="menuitem" onClick={() => choose(() => actions.retry("projects"))}>重试</button>
              )}
            </div>
          )}
          {availability.state === "ready" && !view.projects.length && <div className="pnav-menu-status">还没有项目</div>}
          {view.projects.map((item) => (
            <button
              key={item.projectId}
              type="button"
              role="menuitemradio"
              aria-checked={item.projectId === view.currentProjectId}
              onClick={() => choose(() => actions.selectProject(item.projectId))}
            >
              <span className="mi-main">
                <span className="mi-name">{item.name}</span>
                {(item.memberCount || item.repo || item.archived) && (
                  <span className="mi-sub">
                    {[item.memberCount ? `${item.memberCount} 人` : null, item.repo || null, item.archived ? "已归档" : null].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
              <span className="pnav-menu-check">{item.projectId === view.currentProjectId && <IconCheck size={14} aria-hidden="true" />}</span>
            </button>
          ))}
          <div className="pnav-menu-sep" />
          <button type="button" role="menuitem" className="pnav-menu-create" onClick={() => choose(actions.createProject)}>
            <IconPlus size={15} aria-hidden="true" />
            <span className="mi-main"><span className="mi-name">新建 Project</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

function toBadgeTone(tone: "neutral" | "accent" | "warning" | "danger"): "neutral" | "accent" | "warn" | "danger" {
  return tone === "warning" ? "warn" : tone;
}

function useScrollIntoViewOnLanding(ref: { current: HTMLButtonElement | null }, landing?: boolean) {
  useEffect(() => {
    if (!landing) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [landing, ref]);
}

function SessionRow({ entry, active, landing, showMeTag, localDeviceName, select, canOpenMenu, onOpenMenu }: {
  entry: NavigationSessionEntry;
  active: boolean;
  landing?: boolean;
  showMeTag?: boolean;
  localDeviceName?: string | null;
  select: ProjectNavigationActions["selectConversation"];
  canOpenMenu: boolean;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useScrollIntoViewOnLanding(rowRef, landing);
  const isOtherDevice = entry.badge?.text.includes("其他设备") ?? false;
  const isStopped = entry.badge?.text === "已停止同步";
  const hasUnread = !isStopped && Boolean(
    entry.badge?.text.includes("有更新") || entry.badge?.text.includes("未同步"),
  );
  const deviceLabel = isOtherDevice ? "其他设备 · 只读" : localDeviceName ? `本机 · ${localDeviceName}` : "本机";

  return (
    <div
      className="pnav-session-row"
      onContextMenu={canOpenMenu ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(event.clientX, event.clientY);
      } : undefined}
    >
      <button
        ref={rowRef}
        type="button"
        className={`sess-item pnav-session${active ? " is-active" : ""}${landing ? " is-landing" : ""}`}
        title={entry.title}
        data-active={active}
        aria-current={active ? "page" : undefined}
        onClick={() => select(entry.conversationId)}
      >
        <span className="sr-top">
          {showMeTag && !isOtherDevice && <span className="sess-me-tag">我</span>}
          <span className="sess-title pnav-ellipsis">{entry.title}</span>
        </span>
        <span className="sess-meta">
          {isOtherDevice && <IconLock size={10} aria-hidden="true" />}
          <span className="line">{deviceLabel} · {entry.timeLabel}</span>
          {entry.badge && entry.badge.text !== "本机" && (
            <span className="hui-badge" data-tone={toBadgeTone(entry.badge.tone)} data-size="xs">{entry.badge.text}</span>
          )}
        </span>
        {hasUnread && <span className="unsync-dot" aria-label="有更新" />}
      </button>
      {canOpenMenu && (
        <button
          type="button"
          className="pnav-icon-button pnav-session-actions"
          aria-label={`会话操作：${entry.title}`}
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.left, rect.bottom + 4);
          }}
        >
          <IconDots size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** 个人空间左栏单条会话行（支持左键切换、右键 Codex 菜单、悬停更多按钮及跨轨落位脉冲）。 */
function PersonalSessionRow({
  entry,
  active,
  landing,
  select,
  canOpenMenu,
  onOpenMenu,
}: {
  entry: NavigationPersonalEntry;
  active: boolean;
  landing?: boolean;
  select?: (conversationId: string) => void;
  canOpenMenu: boolean;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useScrollIntoViewOnLanding(rowRef, landing);

  return (
    <div
      className="pnav-session-row"
      onContextMenu={canOpenMenu ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu(event.clientX, event.clientY);
      } : undefined}
    >
      <button
        ref={rowRef}
        type="button"
        className={`sess-item pnav-session${active ? " is-active" : ""}${landing ? " is-landing" : ""}`}
        title={entry.title}
        data-active={active}
        aria-current={active ? "page" : undefined}
        onClick={() => select?.(entry.conversationId)}
      >
        <span className="sr-top">
          <span className="sess-title pnav-ellipsis">{entry.title}</span>
        </span>
        <span className="sess-meta">
          {entry.status === "running" && <span className="sess-run" title="运行中" aria-label="运行中" />}
          {entry.shareStatus === "stopped" ? (
            <span className="hui-badge" data-tone="warn" data-size="xs">已停止同步</span>
          ) : (
            <IconLock size={10} aria-hidden="true" />
          )}
          <span className="line">{entry.shareStatus === "stopped" ? entry.timeLabel : `本机 · ${entry.timeLabel}`}</span>
        </span>
      </button>
      {canOpenMenu && (
        <button
          type="button"
          className="pnav-icon-button pnav-session-actions"
          aria-label={`会话操作：${entry.title}`}
          aria-haspopup="menu"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.left, rect.bottom + 4);
          }}
        >
          <IconDots size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ProjectNavigation({ view, actions }: ProjectNavigationProps): ReactElement {
  const dualTrack = view.activeSpace !== undefined;
  const activeSpace: NavigationSpaceKind = view.activeSpace ?? "team";
  const isPersonalSpace = dualTrack && activeSpace === "personal";
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly items: readonly SessionContextMenuItem[];
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    readonly conversationId: string;
    readonly initialTitle: string;
    readonly onSubmit: (title: string) => Promise<string | null>;
  } | null>(null);

  const hasProject = view.currentProjectId !== null;
  const selfGroup = view.groups.find((g) => g.self);
  const mySessions = selfGroup?.sessions ?? [];
  const peerGroups = view.groups.filter((g) => !g.self && g.sessions.length > 0);
  const peerSessionCount = peerGroups.reduce((sum, g) => sum + g.sessions.length, 0);
  const activeTeamSessionCount = mySessions.length + peerSessionCount;
  const inboxActive = Boolean(view.inbox?.active);
  const cloudActionCount = view.inbox?.cloudActionCount ?? 0;
  const localAttentionCount = view.inbox?.localAttentionCount ?? 0;
  const prevCloudCountRef = useRef<number | null>(null);
  const [badgeTicking, setBadgeTicking] = useState(false);
  useEffect(() => {
    const prev = prevCloudCountRef.current;
    prevCloudCountRef.current = cloudActionCount;
    if (prev !== null && cloudActionCount > prev) {
      setBadgeTicking(true);
      const timer = setTimeout(() => setBadgeTicking(false), 320);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [cloudActionCount]);

  const effectiveActivePage = inboxActive ? null : view.activePage;
  const knowActive = effectiveActivePage === "knowledge";
  const isSearchingLocalOnly = !actions.openCommandPalette && view.search.trim() !== "";
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setContextMenu(null);
  }, [activeSpace, view.currentWorkspaceId, view.currentProjectId]);

  // 发布到 Project 或停止共享移回个人空间时，自动展开包含目标会话的目录/项目分组，让 row-land 脉冲可见。
  useEffect(() => {
    const landingId = view.landingConversationId;
    if (!landingId) return;
    const matchedDir = (view.personalGroups ?? []).find((group) =>
      group.records.some((rec) => rec.conversationId === landingId),
    );
    if (matchedDir) {
      setCollapsedDirs((prev) => (prev[matchedDir.directoryKey] ? { ...prev, [matchedDir.directoryKey]: false } : prev));
    }
    if (view.currentProjectId) {
      const inCurrentProject = mySessions.some((entry) => entry.conversationId === landingId)
        || peerGroups.some((group) => group.sessions.some((entry) => entry.conversationId === landingId));
      if (inCurrentProject) {
        const pid = view.currentProjectId;
        setCollapsedProjects((prev) => (prev[pid] ? { ...prev, [pid]: false } : prev));
      }
    }
  }, [view.landingConversationId, view.personalGroups, view.currentProjectId, mySessions, peerGroups]);

  useEffect(() => {
    if (actions.openCommandPalette || isPersonalSpace) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !hasProject) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasProject, actions.openCommandPalette, isPersonalSpace]);

  const personalQuery = (view.personalSearch ?? "").trim().toLocaleLowerCase();
  const totalPersonalCount = (view.personalGroups ?? []).reduce((sum, group) => sum + group.records.length, 0);
  const visiblePersonalGroups = (view.personalGroups ?? [])
    .map((group) => ({
      ...group,
      records: personalQuery
        ? group.records.filter((r) =>
            r.title.toLocaleLowerCase().includes(personalQuery)
            || group.label.toLocaleLowerCase().includes(personalQuery),
          )
        : group.records,
    }))
    .filter((group) => group.records.length > 0);

  function openPersonalMenu(entry: NavigationPersonalEntry, x: number, y: number) {
    const items: SessionContextMenuItem[] = [];
    if (actions.renamePersonalConversation) {
      const rename = actions.renamePersonalConversation;
      items.push({
        id: "rename",
        label: "重命名",
        icon: <IconPencil size={15} aria-hidden="true" />,
        onSelect: () => {
          setRenameTarget({
            conversationId: entry.conversationId,
            initialTitle: entry.title,
            onSubmit: (nextTitle) => rename(entry.conversationId, nextTitle),
          });
        },
      });
    }
    if (entry.shareStatus === "local_only" && actions.publishPersonalConversation) {
      const publish = actions.publishPersonalConversation;
      const canPublish = !view.offline && view.canPublishPersonal !== false;
      items.push({
        id: "publish",
        label: "发布到 Project…",
        icon: <IconUpload size={15} aria-hidden="true" />,
        separatorBefore: items.length > 0,
        disabled: !canPublish,
        disabledReason: view.offline ? "协作服务离线，暂不可发布" : "当前账号尚未加入团队",
        onSelect: () => publish(entry.conversationId),
      });
    }
    if (items.length > 0) setContextMenu({ x, y, items });
  }

  function openTeamSessionMenu(entry: NavigationSessionEntry, x: number, y: number) {
    const isOtherDevice = entry.badge?.text.includes("其他设备") ?? false;
    const isStopped = entry.badge?.text === "已停止同步";
    const items: SessionContextMenuItem[] = [];
    if (actions.renameConversation && !isOtherDevice) {
      const rename = actions.renameConversation;
      items.push({
        id: "rename",
        label: "重命名",
        icon: <IconPencil size={15} aria-hidden="true" />,
        onSelect: () => {
          setRenameTarget({
            conversationId: entry.conversationId,
            initialTitle: entry.title,
            onSubmit: (nextTitle) => rename(entry.conversationId, nextTitle),
          });
        },
      });
    }
    if (actions.stopSharingConversation && !isOtherDevice && !isStopped) {
      const stopSharing = actions.stopSharingConversation;
      items.push({
        id: "stop-sharing",
        label: "停止共享",
        icon: <IconBan size={15} aria-hidden="true" />,
        separatorBefore: items.length > 0,
        disabled: Boolean(view.offline),
        disabledReason: "协作服务离线，暂不可停止共享",
        onSelect: () => stopSharing(entry.conversationId),
      });
    }
    if (items.length > 0) setContextMenu({ x, y, items });
  }

  return (
    <nav
      className="project-navigation"
      data-dual={dualTrack ? "true" : undefined}
      aria-label={isPersonalSpace ? "个人空间导航" : "工作台导航"}
    >
      {/* 0. 双轨工作台页头与「个人 | 团队」分段切换（全局业务入口已上收至 56px AppRail） */}
      {dualTrack && (
        <>
          <div className="sb-head">
            <span className="sb-head-title">工作台</span>
          </div>
          <div className="sb-seg-wrap">
            <div className="sb-seg" role="tablist" aria-label="切换工作区空间">
              <button
                type="button"
                role="tab"
                aria-selected={activeSpace === "personal"}
                className={activeSpace === "personal" ? "is-active" : ""}
                onClick={() => actions.selectSpace?.("personal")}
              >
                <IconUser size={13} className="od-icon" aria-hidden="true" />
                <span>个人</span>
                {totalPersonalCount > 0 && <span className="seg-count">{totalPersonalCount}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeSpace === "team"}
                className={activeSpace === "team" ? "is-active" : ""}
                onClick={() => actions.selectSpace?.("team")}
              >
                <IconUsers size={13} className="od-icon" aria-hidden="true" />
                <span>团队</span>
                {view.hasTeamUpdates && <span className="sp-dot" title="队友会话有更新" />}
              </button>
            </div>
          </div>
        </>
      )}

      {/* 传统单栏预览保留 Inbox 与全局业务入口（双轨模式由 56px AppRail 承担） */}
      {!dualTrack && view.inbox && actions.openInbox && (
        <div className="sb-inbox-wrap">
          <button
            type="button"
            className="pnav-nav-item pnav-inbox-btn"
            data-active={inboxActive ? "true" : undefined}
            aria-current={inboxActive ? "page" : undefined}
            onClick={actions.openInbox}
          >
            <IconInbox size={15} aria-hidden="true" />
            <span className="pnav-nav-label">收件箱</span>
            {(localAttentionCount > 0 || cloudActionCount > 0) && (
              <span className="pnav-inbox-indicators">
                {localAttentionCount > 0 && (
                  <span
                    className="pnav-inbox-local"
                    title={`本机有 ${localAttentionCount} 个等待你确认或出错的会话`}
                  >
                    <span className="pnav-inbox-amber-dot" aria-hidden="true" />
                    <span>本机 {localAttentionCount}</span>
                  </span>
                )}
                {cloudActionCount > 0 && (
                  <span
                    className={`pnav-inbox-badge${badgeTicking ? " is-ticking" : ""}`}
                    aria-label={`${cloudActionCount} 项云端待办`}
                    title={`跨团队待我处理：${cloudActionCount} 项`}
                  >
                    {cloudActionCount > 99 ? "99+" : cloudActionCount}
                  </span>
                )}
              </span>
            )}
          </button>
        </div>
      )}

      {isPersonalSpace ? (
        <>
          <div className="sb-actions-wrap">
            <div className="sb-actions">
              <button
                type="button"
                className="pnav-new"
                data-active={!inboxActive && view.selectedPersonalConversationId === null}
                onClick={() => actions.createPersonalSession?.()}
              >
                <IconPencil size={14} aria-hidden="true" />
                <span>新建个人会话</span>
              </button>
              {actions.openCommandPalette && (
                <button
                  type="button"
                  className="pnav-icon-button sb-search-btn"
                  aria-label="全局搜索"
                  title="全局搜索 (⌘K)"
                  onClick={actions.openCommandPalette}
                >
                  <IconSearch size={15} aria-hidden="true" />
                </button>
              )}
            </div>
            {actions.setPersonalSearch && (
              <div className="sb-filter-wrap">
                <label className="pnav-search">
                  <IconSearch size={14} aria-hidden="true" />
                  <input
                    aria-label="搜索个人会话"
                    placeholder="过滤本机会话或目录"
                    value={view.personalSearch ?? ""}
                    onChange={(event) => actions.setPersonalSearch?.(event.target.value)}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="my-sessions" aria-label="个人会话">
            <div className="sb-scroll">
              <div className="sb-block-head">
                <span>我的个人会话</span>
                {totalPersonalCount > 0 && <span className="sb-block-act count">{totalPersonalCount}</span>}
              </div>

              {visiblePersonalGroups.length === 0 ? (
                <p className="side-empty">
                  {personalQuery ? (
                    "没有匹配的本机个人会话。"
                  ) : (
                    <>
                      还没有个人会话。
                      <br />
                      在右侧选择目录或直接发送消息即可开始。
                    </>
                  )}
                </p>
              ) : (
                visiblePersonalGroups.map((group) => {
                  const open = Boolean(personalQuery) || collapsedDirs[group.directoryKey] !== true;
                  return (
                    <div key={group.directoryKey} className="sb-grp">
                      <button
                        type="button"
                        className={`grp-head${open ? "" : " is-closed"}`}
                        aria-expanded={open}
                        title={group.directoryPath ?? group.label}
                        onClick={() => setCollapsedDirs((prev) => ({
                          ...prev,
                          [group.directoryKey]: open,
                        }))}
                      >
                        <span className="chev">
                          <IconChevronDown size={13} aria-hidden="true" />
                        </span>
                        <IconFolder size={15} aria-hidden="true" />
                        <span className="d pnav-ellipsis">{group.label}</span>
                        <span className="n">{group.records.length}</span>
                      </button>
                      <div className="grp-collapse" data-open={open ? "1" : "0"} inert={!open || undefined}>
                        <div className="grp-collapse-inner">
                          <div className="grp-body">
                            {group.records.map((entry) => (
                              <PersonalSessionRow
                                key={entry.conversationId}
                                entry={entry}
                                active={!inboxActive && view.selectedPersonalConversationId === entry.conversationId}
                                landing={view.landingConversationId === entry.conversationId}
                                select={actions.selectPersonalConversation}
                                canOpenMenu={Boolean(
                                  actions.renamePersonalConversation
                                  || (entry.shareStatus === "local_only" && actions.publishPersonalConversation),
                                )}
                                onOpenMenu={(x, y) => openPersonalMenu(entry, x, y)}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              {(view.publishedSessionCount ?? 0) > 0 && (
                <button
                  type="button"
                  className="pane-foot"
                  onClick={() => actions.selectSpace?.("team")}
                >
                  另有 {view.publishedSessionCount} 个会话已发布到 Project，在「团队」空间里。
                </button>
              )}
            </div>
          </div>
        </>
      ) : dualTrack && view.offline ? (
        <div className="my-sessions pnav-team-empty" aria-label="团队空间离线">
          <div className="pnav-state-card" role="status">
            <IconAlertTriangle size={16} aria-hidden="true" />
            <p>协作服务暂不可达。团队看板与跨机同步暂不可用，本机个人会话可正常使用。</p>
            <div className="pnav-state-actions">
              {actions.reconnect && (
                <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={actions.reconnect}>
                  <IconRefresh size={13} aria-hidden="true" />
                  <span>重连</span>
                </button>
              )}
              <button
                type="button"
                className="wb-button wb-button-primary wb-button-small"
                onClick={() => actions.selectSpace?.("personal")}
              >
                回到个人空间
              </button>
            </div>
          </div>
        </div>
      ) : dualTrack && !view.workspaceName ? (
        <div className="my-sessions pnav-team-empty" aria-label="未加入团队">
          <div className="pnav-state-card" role="status">
            <IconUsers size={16} aria-hidden="true" />
            <p>当前账号尚未加入团队。无需等待入团，直接在本机使用个人 Agent 对话。</p>
            <div className="pnav-state-actions">
              <button
                type="button"
                className="wb-button wb-button-primary wb-button-small"
                onClick={() => actions.selectSpace?.("personal")}
              >
                回到个人空间
              </button>
            </div>
          </div>
        </div>
      ) : dualTrack ? (
        <>
          <div className="sb-actions-wrap">
            <div className="sb-actions">
              <button
                type="button"
                className="pnav-new"
                data-active={effectiveActivePage === "new"}
                aria-current={effectiveActivePage === "new" ? "page" : undefined}
                disabled={!hasProject}
                onClick={() => (actions.createSession ? actions.createSession() : actions.openPage("new"))}
              >
                <IconPlus size={15} aria-hidden="true" />
                <span>新建协作会话</span>
              </button>
              {actions.openCommandPalette && (
                <button
                  type="button"
                  className="pnav-icon-button sb-search-btn"
                  aria-label="全局搜索"
                  title="全局搜索 (⌘K)"
                  onClick={actions.openCommandPalette}
                >
                  <IconSearch size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <div className="my-sessions" aria-label="Project 协作会话">
            <div className="sb-scroll">
              <WorkspaceSwitch view={view} actions={actions} dualTrack />

              <div className="sb-block-head">
                <span>Project 协作会话</span>
                {hasProject && view.sessionsAvailability.state === "ready" && (
                  <span className="sb-block-act count">
                    {mySessions.length} 我 / {peerSessionCount} 队友
                  </span>
                )}
              </div>

              {view.projectsAvailability.state === "failed" && !view.projects.length && (
                <Status value={view.projectsAvailability} area="projects" actions={actions} />
              )}

              {!view.projects.length ? (
                view.projectsAvailability.state === "ready" && (
                  <div className="pnav-empty">
                    <p>还没有项目。</p>
                    <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={actions.createProject}>
                      <IconPlus size={13} aria-hidden="true" />
                      <span>创建项目</span>
                    </button>
                  </div>
                )
              ) : (
                <>
                  {view.projects.map((project) => {
                    // 仅当前激活 Project 默认展开并拉取会话，保持单 Project 请求契约以防请求风暴（HC-225）。
                    const isCurrent = project.projectId === view.currentProjectId;
                    const open = isCurrent && collapsedProjects[project.projectId] !== true;
                    return (
                      <div key={project.projectId} className="cp-proj">
                        <div className="cp-proj-row">
                          <button
                            type="button"
                            className={`grp-head cp-head${open ? "" : " is-closed"}${isCurrent ? " is-current" : ""}`}
                            aria-expanded={open}
                            title={project.name}
                            onClick={() => {
                              if (isCurrent) {
                                setCollapsedProjects((prev) => ({ ...prev, [project.projectId]: open }));
                              } else {
                                setCollapsedProjects((prev) => ({ ...prev, [project.projectId]: false }));
                                actions.selectProject(project.projectId);
                              }
                            }}
                          >
                            <span className="chev">
                              <IconChevronDown size={13} aria-hidden="true" />
                            </span>
                            <span className="d pnav-ellipsis">{project.name}</span>
                            {project.archived && <span className="hui-badge" data-tone="muted" data-size="xs">已归档</span>}
                            {isCurrent && view.sessionsAvailability.state === "ready" && (
                              <span className="n">{activeTeamSessionCount}</span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="pnav-icon-button cp-gear"
                            aria-label={`${project.name} 资料与成员`}
                            title="Project 资料与成员"
                            data-active={isCurrent && view.activePage === "info"}
                            onClick={() => {
                              if (actions.openProjectSettingsFor) {
                                actions.openProjectSettingsFor(project.projectId);
                              } else if (isCurrent) {
                                actions.openProjectSettings();
                              } else {
                                actions.selectProject(project.projectId);
                              }
                            }}
                          >
                            <IconAdjustmentsHorizontal size={13} aria-hidden="true" />
                          </button>
                        </div>
                        <div className="grp-collapse" data-open={open ? "1" : "0"} inert={!open || undefined}>
                          <div className="grp-collapse-inner">
                            {isCurrent ? (
                              <div className="cp-body">
                                <Status value={view.membersAvailability} area="members" actions={actions} />
                                {view.membersAvailability.state !== "denied" && (
                                  <Status value={view.sessionsAvailability} area="sessions" actions={actions} />
                                )}
                                {view.sessionsAvailability.state === "ready" && mySessions.length === 0 && peerGroups.length === 0 && (
                                  <p className="cp-empty">暂无已发布会话</p>
                                )}
                                {mySessions.map((entry) => {
                                  const isOtherDevice = entry.badge?.text.includes("其他设备") ?? false;
                                  const isStopped = entry.badge?.text === "已停止同步";
                                  const canOpenMenu = !isOtherDevice && Boolean(
                                    actions.renameConversation || (actions.stopSharingConversation && !isStopped),
                                  );
                                  return (
                                    <SessionRow
                                      key={`${project.projectId}:${entry.conversationId}`}
                                      entry={entry}
                                      active={effectiveActivePage === "conversation" && view.selectedConversationId === entry.conversationId}
                                      landing={view.landingConversationId === entry.conversationId}
                                      showMeTag
                                      localDeviceName={view.localDeviceName}
                                      select={actions.selectConversation}
                                      canOpenMenu={canOpenMenu}
                                      onOpenMenu={(x, y) => openTeamSessionMenu(entry, x, y)}
                                    />
                                  );
                                })}
                                {peerGroups.map((group) => (
                                  <div key={group.userId} className="sb-grp pnav-peer-grp">
                                    <div className="pnav-peer-head">
                                      <MemberAvatar initial={group.initial} photo={group.photo} size={18} />
                                      <span className="pnav-ellipsis">{group.label}</span>
                                      <span className="n">{group.sessions.length}</span>
                                    </div>
                                    {group.sessions.map((entry) => {
                                      const active = effectiveActivePage === "conversation" && view.selectedConversationId === entry.conversationId;
                                      const landing = view.landingConversationId === entry.conversationId;
                                      const isStopped = entry.badge?.text === "已停止同步";
                                      const hasPeerUpdate = !isStopped && Boolean(
                                        entry.badge?.text.includes("有更新") || entry.badge?.text.includes("未同步"),
                                      );
                                      return (
                                        <button
                                          key={`${project.projectId}:${entry.conversationId}`}
                                          type="button"
                                          className={`sess-item pnav-session${active ? " is-active" : ""}${landing ? " is-landing" : ""}`}
                                          title={entry.title}
                                          data-active={active}
                                          aria-current={active ? "page" : undefined}
                                          onClick={() => actions.selectConversation(entry.conversationId)}
                                        >
                                          <span className="sr-top">
                                            <span className="sess-title pnav-ellipsis">{entry.title}</span>
                                          </span>
                                          <span className="sess-meta">
                                            <IconLock size={10} aria-hidden="true" />
                                            <span className="line">只读 · {entry.timeLabel}</span>
                                            {entry.badge && (
                                              <span className="hui-badge" data-tone={toBadgeTone(entry.badge.tone)} data-size="xs">{entry.badge.text}</span>
                                            )}
                                          </span>
                                          {hasPeerUpdate && <span className="unsync-dot" aria-label="有未同步更新" />}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <button type="button" className="nav-item cp-create-proj" onClick={actions.createProject}>
                    <IconPlus size={14} aria-hidden="true" />
                    <span className="nav-label">新建 Project</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* 1. Workspace 团队组 + 团队知识库入口（单栏独立预览兼容分支） */}
          <div className="side-group">
            <p className="pnav-eyebrow">Workspace</p>
            <WorkspaceSwitch view={view} actions={actions} dualTrack={false} />
            <button
              type="button"
              className="pnav-nav-item"
              data-active={knowActive}
              aria-current={knowActive ? "page" : undefined}
              disabled={!view.workspaceName}
              title="Workspace 团队知识库"
              onClick={() => actions.openPage("knowledge")}
            >
              <IconBook size={15} aria-hidden="true" />
              <span className="pnav-nav-label">团队知识库</span>
              {view.knowledgeCount !== null && view.knowledgeCount !== undefined && (
                <span className="pnav-nav-count">{view.knowledgeCount}</span>
              )}
            </button>
          </div>

          <div className="pnav-divider" aria-hidden="true" />

          {/* 2. Project 切换 + Project 看板 / 任务入口 */}
          <div className="side-group">
            <p className="pnav-eyebrow">Project</p>
            <ProjectSwitch view={view} actions={actions} />
            {view.projectsAvailability.state === "failed" && !view.projects.length && (
              <Status value={view.projectsAvailability} area="projects" actions={actions} />
            )}
            <div className="pnav-tools" aria-label="Project 导航">
              <button
                type="button"
                className="pnav-nav-item"
                disabled={!hasProject}
                data-active={effectiveActivePage === "board"}
                aria-current={effectiveActivePage === "board" ? "page" : undefined}
                onClick={() => actions.openPage("board")}
              >
                <IconLayoutGrid size={15} aria-hidden="true" />
                <span className="pnav-nav-label">Project 看板</span>
              </button>
              <button
                type="button"
                className="pnav-nav-item"
                disabled={!hasProject}
                data-active={effectiveActivePage === "tasks"}
                aria-current={effectiveActivePage === "tasks" ? "page" : undefined}
                onClick={() => actions.openPage("tasks")}
              >
                <IconListCheck size={15} aria-hidden="true" />
                <span className="pnav-nav-label">任务</span>
                {view.taskCount !== null && view.taskCount > 0 && (
                  <span className="pnav-nav-count">{view.taskCount}</span>
                )}
              </button>
            </div>
          </div>

          {/* 3. 新建会话按钮 & 全局搜索触发器 (⌘K) */}
          <div className="pnav-actions">
            <button
              type="button"
              className="pnav-new"
              data-active={effectiveActivePage === "new"}
              aria-current={effectiveActivePage === "new" ? "page" : undefined}
              disabled={!hasProject}
              onClick={() => (actions.createSession ? actions.createSession() : actions.openPage("new"))}
            >
              <IconPlus size={15} aria-hidden="true" />
              <span>新建会话</span>
            </button>

            {actions.openCommandPalette ? (
              <button
                type="button"
                className="search-btn"
                aria-label="全局搜索"
                disabled={!hasProject}
                onClick={actions.openCommandPalette}
              >
                <IconSearch size={14} aria-hidden="true" />
                <span className="pnav-ellipsis">搜索会话、任务、知识</span>
                <span className="kbd">⌘K</span>
              </button>
            ) : (
              <label className="pnav-search">
                <IconSearch size={14} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  aria-label="搜索会话"
                  placeholder="搜索我的会话"
                  value={view.search}
                  disabled={!hasProject}
                  onChange={(event) => actions.setSearch(event.target.value)}
                />
                <span className="kbd" aria-hidden="true">⌘K</span>
              </label>
            )}
          </div>

          {/* 4. 我的会话（仅单栏独立预览渲染） */}
          <div className="my-sessions" aria-label="我的会话">
            <div className="sec-head">
              <span className="label">我的会话</span>
              {view.sessionsAvailability.state === "ready" && mySessions.length > 0 && (
                <span className="count">{mySessions.length} 条</span>
              )}
            </div>

            <div className="sess-list">
              {!hasProject ? (
                view.projectsAvailability.state === "ready" && (
                  <div className="pnav-empty">
                    <p>{view.projects.length ? "选择一个项目开始协作。" : "还没有项目。"}</p>
                    {!view.projects.length && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={actions.createProject}>
                        <IconPlus size={13} aria-hidden="true" />
                        <span>创建项目</span>
                      </button>
                    )}
                  </div>
                )
              ) : (
                <>
                  <Status value={view.membersAvailability} area="members" actions={actions} />
                  {view.membersAvailability.state !== "denied" && (
                    <Status value={view.sessionsAvailability} area="sessions" actions={actions} />
                  )}
                  {view.sessionsAvailability.state === "ready" && mySessions.length === 0 && (
                    <p className="side-empty">
                      {isSearchingLocalOnly ? "没有匹配的会话。" : <>还没有会话。<br />点击上面的「新建会话」开始。</>}
                    </p>
                  )}
                  {mySessions.map((entry) => {
                    const isOtherDevice = entry.badge?.text.includes("其他设备") ?? false;
                    return (
                      <SessionRow
                        key={`${view.currentProjectId}:${entry.conversationId}`}
                        entry={entry}
                        active={effectiveActivePage === "conversation" && view.selectedConversationId === entry.conversationId}
                        localDeviceName={view.localDeviceName}
                        select={actions.selectConversation}
                        canOpenMenu={Boolean(actions.renameConversation && !isOtherDevice)}
                        onOpenMenu={(x, y) => openTeamSessionMenu(entry, x, y)}
                      />
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* 5. 底部当前账号与系统设置（单栏预览保留） */}
          <div className="side-foot">
            <MemberAvatar initial={(view.accountName ?? "?").slice(0, 1)} photo={view.accountPhoto} self size={28} />
            <span className="who">
              <span className="who-name pnav-ellipsis">{view.accountName ?? "未登录"}</span>
              <span className="who-role pnav-ellipsis">
                {view.offline
                  ? "离线续用"
                  : view.accountRole || view.workspaceName || "未加入团队"}
              </span>
            </span>
            <button
              type="button"
              className="pnav-icon-button"
              aria-label="设置"
              title="系统设置"
              onClick={actions.openSettings}
            >
              <IconSettings size={16} aria-hidden="true" />
            </button>
          </div>
        </>
      )}

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {renameTarget && (
        <RenameSessionDialog
          initialTitle={renameTarget.initialTitle}
          onClose={() => setRenameTarget(null)}
          onSubmit={renameTarget.onSubmit}
        />
      )}
    </nav>
  );
}
