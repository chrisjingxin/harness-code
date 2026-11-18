/**
 * Project 导航（1:1 还原原型稿左侧边栏）：
 * Workspace 切换 + 团队知识库入口 → Project 切换 + 看板/任务 → + 新建会话 + 搜索按钮(⌘K) → 仅我的会话列表 → 个人栏。
 * 组件不发请求、不持有身份或个人状态；所有意图通过 actions 回传给宿主。
 */
import {
  BookOpen,
  Check,
  ChevronDown,
  LayoutGrid,
  ListChecks,
  Lock,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { NavigationMemberGroup } from "./members.js";

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
};

export type ProjectNavigationActions = {
  selectWorkspace?(workspaceId: string): void;
  selectProject(projectId: string): void;
  createProject(): void;
  openProjectSettings(): void;
  openPage(kind: "new" | "board" | "tasks" | "knowledge"): void;
  /** 若宿主支持新建会话弹窗，优先触发该函数。 */
  createSession?(): void;
  selectConversation(conversationId: string): void;
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

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;

function safeAvatarUrl(photo?: string | null): string | null {
  if (!photo) return null;
  if (SAFE_DATA_IMAGE_RE.test(photo)) return photo;
  if (
    (photo.startsWith("/") && !photo.startsWith("//"))
    || photo.startsWith("./")
    || photo.startsWith("../")
    || photo.startsWith("assets/")
  ) {
    return photo;
  }
  try {
    const url = new URL(photo);
    return url.protocol === "https:"
      || url.protocol === "http:"
      || url.protocol === "file:"
      || url.protocol === "blob:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
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

/** Workspace 切换器（头像堆叠 + Workspace 名称 + 成员数 + 下拉切换）。 */
function WorkspaceSwitch({ view, actions }: ProjectNavigationProps) {
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
        <ChevronDown size={14} className="chev" />
      </button>

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
                <span className="pnav-menu-check">{on && <Check size={14} />}</span>
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
        <ChevronDown size={14} className="chev" />
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
        <SlidersHorizontal size={15} />
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
              <span className="pnav-menu-check">{item.projectId === view.currentProjectId && <Check size={14} />}</span>
            </button>
          ))}
          <div className="pnav-menu-sep" />
          <button type="button" role="menuitem" className="pnav-menu-create" onClick={() => choose(actions.createProject)}>
            <Plus size={15} />
            <span className="mi-main"><span className="mi-name">新建 Project</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

export function ProjectNavigation({ view, actions }: ProjectNavigationProps): ReactElement {
  const hasProject = view.currentProjectId !== null;
  const selfGroup = view.groups.find((g) => g.self);
  const mySessions = selfGroup?.sessions ?? [];
  const knowActive = view.activePage === "knowledge";
  const isSearchingLocalOnly = !actions.openCommandPalette && view.search.trim() !== "";
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (actions.openCommandPalette) return;
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
  }, [hasProject, actions.openCommandPalette]);

  return (
    <nav className="project-navigation" aria-label="项目导航">
      {/* 1. Workspace 团队组 + 团队知识库入口 */}
      <div className="side-group">
        <p className="pnav-eyebrow">Workspace</p>
        <WorkspaceSwitch view={view} actions={actions} />
        <button
          type="button"
          className="pnav-nav-item"
          data-active={knowActive}
          aria-current={knowActive ? "page" : undefined}
          disabled={!view.workspaceName}
          title="Workspace 团队知识库"
          onClick={() => actions.openPage("knowledge")}
        >
          <BookOpen size={15} />
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
            data-active={view.activePage === "board"}
            aria-current={view.activePage === "board" ? "page" : undefined}
            onClick={() => actions.openPage("board")}
          >
            <LayoutGrid size={15} />
            <span className="pnav-nav-label">Project 看板</span>
          </button>
          <button
            type="button"
            className="pnav-nav-item"
            disabled={!hasProject}
            data-active={view.activePage === "tasks"}
            aria-current={view.activePage === "tasks" ? "page" : undefined}
            onClick={() => actions.openPage("tasks")}
          >
            <ListChecks size={15} />
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
          data-active={view.activePage === "new"}
          aria-current={view.activePage === "new" ? "page" : undefined}
          disabled={!hasProject}
          onClick={() => (actions.createSession ? actions.createSession() : actions.openPage("new"))}
        >
          <Plus size={15} />
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
            <Search size={14} />
            <span className="pnav-ellipsis">搜索会话、任务、知识</span>
            <span className="kbd">⌘K</span>
          </button>
        ) : (
          <label className="pnav-search">
            <Search size={14} />
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

      {/* 4. 我的会话（左栏只保留本人会话，队友会话在顶栏协作成员浮层与 ⌘K 面板） */}
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
                    <Plus size={13} />
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
                  {isSearchingLocalOnly ? (
                    "没有匹配的本机会话。"
                  ) : (
                    <>
                      这个 Project 还没有本机会话。
                      <br />
                      点上面的「新建会话」开始。
                    </>
                  )}
                </p>
              )}
              {mySessions.map((entry) => {
                const active = view.activePage === "conversation" && view.selectedConversationId === entry.conversationId;
                const isOtherDevice = entry.badge?.text.includes("其他设备") ?? false;
                const hasUnread = entry.badge?.tone === "accent" || entry.badge?.tone === "warning";
                const deviceLabel = isOtherDevice
                  ? "其他设备 · 只读"
                  : view.localDeviceName
                    ? `本机 · ${view.localDeviceName}`
                    : "本机";
                const metaText = `${deviceLabel} · ${entry.timeLabel}`;
                return (
                  <button
                    key={entry.conversationId}
                    type="button"
                    className={`sess-item pnav-session${active ? " is-active" : ""}`}
                    title={entry.title}
                    data-active={active}
                    aria-current={active ? "page" : undefined}
                    onClick={() => actions.selectConversation(entry.conversationId)}
                  >
                    <span className="sess-title pnav-ellipsis">{entry.title}</span>
                    <span className="sess-meta">
                      {isOtherDevice && <Lock size={10} />}
                      <span className="line">{metaText}</span>
                    </span>
                    {hasUnread && <span className="unsync-dot" aria-label="有更新" />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* 5. 底部当前账号与系统设置 */}
      <div className="side-foot">
        <MemberAvatar initial={(view.accountName ?? "?").slice(0, 1)} photo={view.accountPhoto} self size={28} />
        <span className="who">
          <span className="who-name pnav-ellipsis">{view.accountName ?? "未登录"}</span>
          <span className="who-role pnav-ellipsis">{view.accountRole || view.workspaceName || "未选择团队"}</span>
        </span>
        <button
          type="button"
          className="pnav-icon-button"
          aria-label="设置"
          title="系统设置"
          onClick={actions.openSettings}
        >
          <Settings size={16} />
        </button>
      </div>
    </nav>
  );
}
