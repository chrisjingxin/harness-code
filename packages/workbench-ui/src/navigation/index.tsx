/**
 * Project 导航：宿主给出项目、成员分组与可用状态 → 组件渲染左栏 → 用户操作只回传具名意图。
 * 组件不发请求、不持有身份或个人状态；折叠、选择与页面记录都由宿主按账号和项目保存。
 */
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { BrandMark } from "../common/brand.js";
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
export type NavigationProjectItem = { projectId: string; name: string; archived: boolean };
export type NavigationRetryArea = "projects" | "members" | "sessions";

export type ProjectNavigationView = {
  accountName: string | null;
  accountPhoto?: string | null;
  workspaceName: string | null;
  projects: readonly NavigationProjectItem[];
  projectsAvailability: NavigationAvailability;
  currentProjectId: string | null;
  groups: readonly NavigationMemberGroup[];
  membersAvailability: NavigationAvailability;
  sessionsAvailability: NavigationAvailability;
  search: string;
  activePage: NavigationPageKind | null;
  selectedConversationId: string | null;
  /** 任务数量由看板/任务模块提供；为空时不显示数字。 */
  taskCount: number | null;
};

export type ProjectNavigationActions = {
  selectProject(projectId: string): void;
  createProject(): void;
  openProjectSettings(): void;
  openPage(kind: "new" | "board" | "tasks" | "knowledge"): void;
  selectConversation(conversationId: string): void;
  toggleMember(userId: string): void;
  setSearch(text: string): void;
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
  if ((photo.startsWith("/") && !photo.startsWith("//")) || photo.startsWith("./")) return photo;
  try {
    const url = new URL(photo);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 成员圆形头像：支持安全远程链接、站内静态路径及打包内联位图，加载失败自动回退到姓名首字。 */
export function MemberAvatar({ initial, photo, self }: { initial: string; photo?: string | null; self?: boolean }): ReactElement {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const candidate = safeAvatarUrl(photo);
  const src = candidate && brokenUrl !== candidate ? candidate : null;
  return (
    <span className="pnav-avatar" data-self={self ? "true" : "false"} aria-hidden="true">
      {src ? <img className="pnav-avatar-img" src={src} alt="" onError={() => setBrokenUrl(candidate)} /> : initial}
    </span>
  );
}

/** 项目下拉只用于选择项目；创建入口在分隔线下，管理动作在独立的设置按钮。 */
function ProjectSwitch({ view, actions }: ProjectNavigationProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = view.projects.find((item) => item.projectId === view.currentProjectId);
  const availability = view.projectsAvailability;
  const label = current?.name
    ?? (availability.state === "ready" ? (view.projects.length ? "选择项目" : "还没有项目") : text(availability));
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
        className="pnav-project-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <FolderOpen size={15} />
          <span className="pnav-ellipsis">{label}</span>
          {current?.archived && <small>已归档</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="pnav-icon-button"
        aria-label="项目设置"
        title="项目设置 · 资料与成员"
        disabled={!current}
        data-active={view.activePage === "info"}
        onClick={actions.openProjectSettings}
      >
        <Settings size={14} />
      </button>
      {open && (
        <div className="pnav-menu" role="menu" aria-label="切换项目">
          <div className="pnav-menu-label">项目</div>
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
              <span className="pnav-menu-check">{item.projectId === view.currentProjectId && <Check size={14} />}</span>
              <span className="pnav-ellipsis">{item.name}</span>
              {item.archived && <small>已归档</small>}
            </button>
          ))}
          <button type="button" role="menuitem" className="pnav-menu-create" onClick={() => choose(actions.createProject)}>
            <Plus size={14} />
            创建项目
          </button>
        </div>
      )}
    </div>
  );
}

function MemberGroup({ group, view, actions }: { group: NavigationMemberGroup; view: ProjectNavigationView; actions: ProjectNavigationActions }) {
  const listId = `pnav-member-${group.userId}`;
  return (
    <section className="pnav-member" data-self={group.self} data-expanded={group.expanded}>
      <button
        type="button"
        className="pnav-member-toggle"
        aria-expanded={group.expanded}
        aria-controls={listId}
        disabled={!group.toggleable}
        onClick={() => actions.toggleMember(group.userId)}
      >
        {group.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <MemberAvatar initial={group.initial} photo={group.photo} self={group.self} />
        <span className="pnav-ellipsis">{group.label}</span>
        {group.detail && <small>{group.detail}</small>}
        {group.left && <small>已离开</small>}
        {view.sessionsAvailability.state === "ready" && <span className="pnav-count">{group.sessions.length}</span>}
      </button>
      <div id={listId} className="pnav-member-items" hidden={!group.expanded}>
        {view.sessionsAvailability.state === "ready" && !group.sessions.length && (
          <p className="pnav-empty">暂无会话</p>
        )}
        {group.sessions.map((entry) => {
          const active = view.activePage === "conversation" && view.selectedConversationId === entry.conversationId;
          return (
            <button
              key={entry.conversationId}
              type="button"
              className="pnav-session"
              title={entry.title}
              data-active={active}
              aria-current={active ? "page" : undefined}
              onClick={() => actions.selectConversation(entry.conversationId)}
            >
              <MessageSquare size={15} />
              <span className="pnav-session-copy">
                <span className="pnav-session-title">{entry.title}</span>
                <span className="pnav-session-meta">
                  {entry.badge && <span data-tone={entry.badge.tone}>{entry.badge.text}</span>}
                  <time>{entry.timeLabel}</time>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ProjectNavigation({ view, actions }: ProjectNavigationProps): ReactElement {
  const hasProject = view.currentProjectId !== null;
  const searching = view.search.trim() !== "";
  return (
    <nav className="project-navigation" aria-label="项目导航">
      <div className="pnav-brand">
        <span className="pnav-brand-mark"><BrandMark /></span>
        Harness Code
      </div>
      <button
        type="button"
        className="pnav-new"
        data-active={view.activePage === "new"}
        aria-current={view.activePage === "new" ? "page" : undefined}
        disabled={!hasProject}
        onClick={() => actions.openPage("new")}
      >
        <SquarePen size={17} />
        新对话
      </button>
      <label className="pnav-search">
        <Search size={16} />
        <input
          aria-label="搜索成员或会话"
          placeholder="搜索成员或会话"
          value={view.search}
          disabled={!hasProject}
          onChange={(event) => actions.setSearch(event.target.value)}
        />
      </label>
      <ProjectSwitch view={view} actions={actions} />
      {view.projectsAvailability.state === "failed" && !view.projects.length && (
        <Status value={view.projectsAvailability} area="projects" actions={actions} />
      )}
      <div className="pnav-tools" aria-label="项目工具">
        <button
          type="button"
          disabled={!hasProject}
          data-active={view.activePage === "board"}
          aria-current={view.activePage === "board" ? "page" : undefined}
          onClick={() => actions.openPage("board")}
        >
          <LayoutGrid size={14} />
          看板
        </button>
        <button
          type="button"
          disabled={!hasProject}
          data-active={view.activePage === "tasks"}
          aria-current={view.activePage === "tasks" ? "page" : undefined}
          onClick={() => actions.openPage("tasks")}
        >
          <ListChecks size={14} />
          任务
          {view.taskCount !== null && <span className="pnav-count">{view.taskCount}</span>}
        </button>
      </div>
      <div className="pnav-sessions" data-searching={searching} aria-label="按成员分组的项目会话">
        {hasProject ? (
          <>
            <Status value={view.membersAvailability} area="members" actions={actions} />
            {view.membersAvailability.state !== "denied" && (
              <Status value={view.sessionsAvailability} area="sessions" actions={actions} />
            )}
            {searching && !view.groups.length && <p className="pnav-empty">没有匹配的成员或会话</p>}
            {view.membersAvailability.state !== "denied" &&
              view.groups.map((group) => <MemberGroup key={group.userId} group={group} view={view} actions={actions} />)}
          </>
        ) : (
          view.projectsAvailability.state === "ready" && (
            <div className="pnav-empty">
              <p>{view.projects.length ? "选择一个项目开始协作。" : "还没有项目。"}</p>
              {!view.projects.length && (
                <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={actions.createProject}>
                  <Plus size={13} />
                  创建项目
                </button>
              )}
            </div>
          )
        )}
      </div>
      <div className="pnav-bottom">
        <button
          type="button"
          className="pnav-item"
          data-active={view.activePage === "knowledge"}
          aria-current={view.activePage === "knowledge" ? "page" : undefined}
          onClick={() => actions.openPage("knowledge")}
        >
          <BookOpen size={16} />
          团队知识
        </button>
        <div className="pnav-account">
          <MemberAvatar initial={(view.accountName ?? "?").slice(0, 1)} photo={view.accountPhoto} self />
          <span className="pnav-account-copy">
            <strong className="pnav-ellipsis">{view.workspaceName ?? "未选择团队"}</strong>
            <small className="pnav-ellipsis">{view.accountName ?? "未登录"}</small>
          </span>
          <button type="button" className="pnav-icon-button" aria-label="设置" onClick={actions.openSettings}>
            <Settings size={16} />
          </button>
        </div>
      </div>
    </nav>
  );
}
