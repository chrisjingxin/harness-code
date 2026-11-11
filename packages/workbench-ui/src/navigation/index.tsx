/** 协作导航只展示宿主提供的事实并发送意图，不持有身份、请求或会话草稿。 */
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Laptop,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { ReactElement } from "react";
import { BrandMark } from "../common/brand.js";

export type NavigationAvailability = {
  state: "ready" | "loading" | "offline" | "denied" | "unavailable";
  message?: string;
  hasMore?: boolean;
};
export type NavigationConversation = {
  id: string;
  title: string;
  deviceId: string;
  projectId: string;
};
export type NavigationProject = {
  id: string;
  name: string;
  expanded: boolean;
  conversations: readonly NavigationConversation[];
  availability: NavigationAvailability;
};
export type NavigationDevice = {
  id: string;
  name: string;
  connection: string;
  expanded: boolean;
  projects: readonly NavigationProject[];
  availability: NavigationAvailability;
};
export type NavigationView = {
  namespace: string;
  accountId: string;
  workspaceId: string | null;
  accountName: string | null;
  workspaces: readonly { id: string; name: string }[];
  devices: readonly NavigationDevice[];
  devicesAvailability: NavigationAvailability;
  shared: readonly NavigationConversation[];
  sharedAvailability: NavigationAvailability;
  pending: {
    state: "unavailable" | "ready" | "loading";
    message: string;
    count?: number;
  };
  selectedConversationId: string | null;
  search: string;
  create: { enabled: boolean; reason?: string };
};
export type NavigationScope = {
  kind: "devices" | "projects" | "conversations" | "shared";
  deviceId?: string;
  projectId?: string;
};
export type NavigationActions = {
  selectWorkspace(id: string): void;
  createConversation(): void;
  selectConversation(id: string): void;
  toggleDevice(id: string): void;
  toggleProject(deviceId: string, projectId: string): void;
  setSearch(text: string): void;
  loadMore(scope: NavigationScope): void;
  retry(scope: NavigationScope): void;
  openPendingHandoffs(): void;
  openSettings(): void;
  signIn(): void;
  signOut(): void;
};
export type NavigationProps = {
  view: NavigationView;
  actions: NavigationActions;
};

function Status({
  value,
  scope,
  actions,
  empty,
}: {
  value: NavigationAvailability;
  scope: NavigationScope;
  actions: NavigationActions;
  empty: boolean;
}): ReactElement | null {
  if (value.state === "ready" && !empty && !value.hasMore) return null;
  return (
    <div className="navigation-status" role="status">
      {value.state !== "ready" ? (
        <span>
          {value.message ??
            (
              {
                loading: "正在加载…",
                offline: "连接已断开，内容可能过时",
                denied: "当前无权访问",
                unavailable: "尚未接入",
              } as const
            )[value.state]}
        </span>
      ) : empty && !value.hasMore ? (
        <span>暂无内容</span>
      ) : null}
      {value.state === "offline" && (
        <button onClick={() => actions.retry(scope)}>重试</button>
      )}
      {value.state === "ready" && value.hasMore && (
        <button onClick={() => actions.loadMore(scope)}>加载更多</button>
      )}
    </div>
  );
}
/** 展开状态由宿主保存；搜索期间临时展开匹配分支，清空后自然恢复。 */
export function CollaborationNavigation({
  view,
  actions,
}: NavigationProps): ReactElement {
  const query = view.search.trim().toLocaleLowerCase();
  const matches = (text: string) =>
    !query || text.toLocaleLowerCase().includes(query);
  const row = (session: NavigationConversation) => (
    <button
      key={session.id}
      className="navigation-row navigation-session"
      data-selected={view.selectedConversationId === session.id}
      aria-current={
        view.selectedConversationId === session.id ? "page" : undefined
      }
      onClick={() => actions.selectConversation(session.id)}
    >
      <MessageSquare size={15} />
      <span>{session.title}</span>
    </button>
  );
  const shared = view.shared.filter((item) => matches(item.title));
  return (
    <nav className="collaboration-navigation" aria-label="协作导航">
      <div className="navigation-account">
        <BrandMark />
        <span>{view.accountName ?? "未登录"}</span>
        <button onClick={actions.openSettings} aria-label="设置">
          <Settings size={16} />
        </button>
        {view.accountName ? (
          <button onClick={actions.signOut}>退出</button>
        ) : (
          <button onClick={actions.signIn}>登录</button>
        )}
      </div>
      <label className="navigation-workspace">
        工作区
        <select
          aria-label="工作区"
          value={view.workspaceId ?? ""}
          onChange={(event) => actions.selectWorkspace(event.target.value)}
        >
          <option value="" disabled>
            选择工作区
          </option>
          {view.workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="navigation-search">
        <Search size={16} />
        <input
          aria-label="搜索已加载内容"
          placeholder="搜索已加载内容"
          value={view.search}
          onChange={(event) => actions.setSearch(event.target.value)}
        />
      </label>
      <button
        className="navigation-create"
        disabled={!view.create.enabled}
        title={view.create.reason}
        onClick={actions.createConversation}
      >
        <Plus size={16} />
        新建会话
      </button>
      {!view.create.enabled && view.create.reason && (
        <p className="navigation-status">{view.create.reason}</p>
      )}
      <div className="navigation-scroll">
        <h3>待接手</h3>
        <p className="navigation-status">{view.pending.message}</p>
        {view.pending.state === "ready" && !!view.pending.count && (
          <button
            className="navigation-row"
            onClick={actions.openPendingHandoffs}
          >
            查看待接手 ({view.pending.count})
          </button>
        )}
        <h3>设备与项目</h3>
        <Status
          value={view.devicesAvailability}
          scope={{ kind: "devices" }}
          actions={actions}
          empty={!view.devices.length}
        />
        {view.devicesAvailability.state !== "denied" &&
          view.devices.map((device) => {
            const projects = device.projects.filter(
              (project) =>
                matches(device.name) ||
                matches(project.name) ||
                project.conversations.some((s) => matches(s.title)),
            );
            if (query && !projects.length && !matches(device.name)) return null;
            return (
              <div key={device.id}>
                <button
                  className="navigation-row"
                  aria-expanded={!!query || device.expanded}
                  onClick={() => actions.toggleDevice(device.id)}
                >
                  {query || device.expanded ? (
                    <ChevronDown size={15} />
                  ) : (
                    <ChevronRight size={15} />
                  )}
                  <Laptop size={16} />
                  <span>{device.name}</span>
                  <small>{device.connection}</small>
                </button>
                {(query || device.expanded) && (
                  <div className="navigation-indent">
                    <Status
                      value={device.availability}
                      scope={{ kind: "projects", deviceId: device.id }}
                      actions={actions}
                      empty={!device.projects.length}
                    />
                    {device.availability.state !== "denied" &&
                      projects.map((project) => {
                        const sessions = project.conversations.filter(
                          (s) =>
                            matches(device.name) ||
                            matches(project.name) ||
                            matches(s.title),
                        );
                        return (
                          <div key={project.id}>
                            <button
                              className="navigation-row"
                              aria-expanded={!!query || project.expanded}
                              onClick={() =>
                                actions.toggleProject(device.id, project.id)
                              }
                            >
                              {query || project.expanded ? (
                                <ChevronDown size={15} />
                              ) : (
                                <ChevronRight size={15} />
                              )}
                              <Folder size={16} />
                              <span>{project.name}</span>
                            </button>
                            {(query || project.expanded) && (
                              <div className="navigation-indent">
                                <Status
                                  value={project.availability}
                                  scope={{
                                    kind: "conversations",
                                    deviceId: device.id,
                                    projectId: project.id,
                                  }}
                                  actions={actions}
                                  empty={!project.conversations.length}
                                />
                                {project.availability.state !== "denied" &&
                                  sessions.map(row)}
                                {project.availability.state === "ready" &&
                                  !project.conversations.length &&
                                  !project.availability.hasMore && (
                                    <button
                                      disabled={!view.create.enabled}
                                      title={view.create.reason}
                                      onClick={actions.createConversation}
                                    >
                                      新建会话
                                    </button>
                                  )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        <h3>
          <Users size={14} />
          共享会话
        </h3>
        <Status
          value={view.sharedAvailability}
          scope={{ kind: "shared" }}
          actions={actions}
          empty={!view.shared.length}
        />
        {view.sharedAvailability.state !== "denied" && shared.map(row)}
        {query && (
          <p className="navigation-status">仅搜索当前工作区已加载内容</p>
        )}
      </div>
    </nav>
  );
}
