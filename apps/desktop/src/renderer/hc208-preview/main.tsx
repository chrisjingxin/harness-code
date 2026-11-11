/** 受控协作导航预览，不连接账号、项目服务或 Agent。 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ThemeMode, WindowState } from "@workbench/contracts";
import {
  CollaborationNavigation,
  WorkbenchLayout,
  ConversationView,
  ProjectDock,
  ProjectFileTab,
  ProjectFilePanel,
} from "@workbench/ui";
import type {
  NavigationView,
  NavigationActions,
  ConversationPersonalState,
  ConversationPersonalChange,
  ProjectPersonalView,
  ProjectActions,
  ProjectGates,
  ProjectFileView,
} from "@workbench/ui";
import "@workbench/ui/theme.css";
import "@workbench/ui/navigation.css";
import "@workbench/ui/layout.css";
import "@workbench/ui/conversation.css";
import "@workbench/ui/project.css";
import "./preview.css";

const scope = {
  namespace: "preview",
  accountId: "user-1",
  workspaceId: "workspace-1",
  deviceId: "device-1",
  projectId: "project-1",
};
const session = {
  id: "conversation-1",
  title: "项目协作讨论",
  deviceId: scope.deviceId,
  projectId: scope.projectId,
};
const enabled = { enabled: true } as const;
const disabled = { enabled: false, reason: "受控预览未接入项目服务" } as const;
const gates: ProjectGates = {
  refreshTree: disabled,
  openFile: enabled,
  refreshFile: disabled,
  openCentral: enabled,
  refreshChanges: disabled,
  readDiff: disabled,
  commit: disabled,
  push: disabled,
};
const file: ProjectFileView = {
  status: "ready",
  file: {
    path: "README.md",
    content: "# 示例项目\n\n这是固定的预览文件。",
    language: "markdown",
    sizeBytes: 42,
    lineCount: 3,
    truncated: false,
    freshness: "cached",
  },
};
const initialPersonal: ConversationPersonalState = {
  scroll: {
    anchorEntryId: null,
    offsetPx: 0,
    following: true,
    seenContentRevision: null,
  },
  expandedTools: [],
  expandedOutputs: [],
  draft: {
    text: "",
    selectionStart: 0,
    selectionEnd: 0,
    revision: 0,
    referenceIds: [],
    attachmentIds: [],
  },
  interactions: {},
};
const initialProject: ProjectPersonalView = {
  dockOpen: true,
  dockWidthPx: 340,
  panel: "files",
  selectedPath: null,
  fileTabs: [],
  activeFilePath: null,
  selectedChanges: [],
  commitMessage: "",
};
function Preview() {
  const [windowState, setWindowState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 });
  const [themeError, setThemeError] = useState("");
  const [signedIn, setSignedIn] = useState(true);
  const [deviceOpen, setDeviceOpen] = useState(false),
    [projectOpen, setProjectOpen] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState(""),
    [settings, setSettings] = useState(false),
    [leftOpen, setLeftOpen] = useState(true),
    [leftWidth, setLeftWidth] = useState(280);
  const [personal, setPersonal] = useState(initialPersonal),
    [project, setProject] = useState(initialProject),
    [central, setCentral] = useState(false),
    [fileOpened, setFileOpened] = useState(false);
  useEffect(() => {
    let active = true;
    const update = (state: WindowState) => {
      if (active) { setWindowState(state); document.documentElement.dataset.theme = state.colorScheme; }
    };
    const off = window.workbench.onWindowStateChanged(update);
    window.workbench
      .getWindowState()
      .then(update)
      .catch(() => {});
    return () => {
      active = false;
      off();
    };
  }, []);
  const view: NavigationView = {
    namespace: scope.namespace,
    accountId: scope.accountId,
    workspaceId: signedIn ? scope.workspaceId : null,
    accountName: signedIn ? "用户甲" : null,
    workspaces: signedIn ? [{ id: scope.workspaceId, name: "示例工作区" }] : [],
    devicesAvailability: { state: "ready" },
    devices: signedIn
      ? [
          {
            id: scope.deviceId,
            name: "示例设备",
            connection: "在线",
            expanded: deviceOpen,
            availability: { state: "ready" },
            projects: [
              {
                id: scope.projectId,
                name: "示例项目",
                expanded: projectOpen,
                availability: { state: "ready" },
                conversations: [session],
              },
            ],
          },
        ]
      : [],
    shared: signedIn ? [session] : [],
    sharedAvailability: { state: "ready" },
    pending: { state: "unavailable", message: "待接手尚未接入" },
    selectedConversationId: selected,
    search,
    create: { enabled: false, reason: "当前没有可创建会话的已接入能力" },
  };
  const navActions: NavigationActions = {
    selectWorkspace: () => {},
    createConversation: () => {},
    selectConversation: setSelected,
    toggleDevice: () => setDeviceOpen((v) => !v),
    toggleProject: () => setProjectOpen((v) => !v),
    setSearch,
    loadMore: () => {},
    retry: () => {},
    openPendingHandoffs: () => {},
    openSettings: () => setSettings(true),
    signIn: () => setSignedIn(true),
    signOut: () => {
      setSelected(null);
      setPersonal(initialPersonal);
      setSignedIn(false);
    },
  };
  const updatePersonal = (
    _scope: unknown,
    change: ConversationPersonalChange,
  ) =>
    setPersonal((previous) => {
      switch (change.kind) {
        case "scroll":
          return { ...previous, scroll: change.value };
        case "tool":
        case "output": {
          const key =
            change.kind === "tool" ? "expandedTools" : "expandedOutputs";
          const values = previous[key];
          return {
            ...previous,
            [key]: change.expanded
              ? [...new Set([...values, change.entryId])]
              : values.filter((id) => id !== change.entryId),
          };
        }
        case "draft-text":
          return {
            ...previous,
            draft: {
              ...previous.draft,
              text: change.text,
              selectionStart: change.selectionStart,
              selectionEnd: change.selectionEnd,
              revision: previous.draft.revision + 1,
            },
          };
        case "draft-references":
          return {
            ...previous,
            draft: {
              ...previous.draft,
              referenceIds: change.referenceIds,
              revision: previous.draft.revision + 1,
            },
          };
        case "draft-attachments":
          return {
            ...previous,
            draft: {
              ...previous.draft,
              attachmentIds: change.attachmentIds,
              revision: previous.draft.revision + 1,
            },
          };
        case "clear-draft":
          return change.expectedRevision === previous.draft.revision
            ? {
                ...previous,
                draft: {
                  ...previous.draft,
                  text: "",
                  selectionStart: 0,
                  selectionEnd: 0,
                  revision: previous.draft.revision + 1,
                },
              }
            : previous;
        default:
          return previous;
      }
    });
  const baseActions: ProjectActions = {
    setDockOpen: (_s, open) => setProject((p) => ({ ...p, dockOpen: open })),
    setDockWidth: (_s, width) =>
      setProject((p) => ({ ...p, dockWidthPx: width })),
    selectPanel: (_s, panel) => setProject((p) => ({ ...p, panel })),
    toggleDirectory: () => {},
    refreshTree: () => {},
    openFile: (_s, path) => {
      setFileOpened(true);
      setProject((p) => ({
        ...p,
        selectedPath: path,
        fileTabs: [{ path, name: "README.md" }],
        activeFilePath: path,
      }));
    },
    selectFileTab: (_s, path) =>
      setProject((p) => ({ ...p, activeFilePath: path })),
    closeFileTab: () =>
      setProject((p) => ({ ...p, fileTabs: [], activeFilePath: null })),
    refreshFile: () => {},
    openCentralFile: () => setCentral(true),
    refreshChanges: () => {},
    readDiff: () => {},
    setSelectedChanges: (_s, selectedChanges) =>
      setProject((p) => ({ ...p, selectedChanges })),
    setCommitMessage: (_s, commitMessage) =>
      setProject((p) => ({ ...p, commitMessage })),
    commit: () => {},
    push: () => {},
  };
  return (
    <WorkbenchLayout
      context={
        selected
          ? {
              title: session.title,
              deviceName: "示例设备",
              projectName: "示例项目",
              connection: "在线",
            }
          : null
      }
      navigation={<CollaborationNavigation view={view} actions={navActions} />}
      leftOpen={leftOpen}
      leftWidthPx={leftWidth}
      rightOpen={project.dockOpen}
      rightWidthPx={project.dockWidthPx}
      setPanelOpen={(side, open) =>
        side === "left"
          ? setLeftOpen(open)
          : setProject((p) => ({ ...p, dockOpen: open }))
      }
      setPanelWidth={(side, width) =>
        side === "left"
          ? setLeftWidth(width)
          : setProject((p) => ({ ...p, dockWidthPx: width }))
      }
      settingsOpen={settings}
      closeSettings={() => setSettings(false)}
      settings={
        <>
          <h2>设置</h2>
          <label className="hc208-theme-setting">外观
            <select aria-label="外观" value={windowState.themeMode} onChange={(event) => {
              setThemeError("");
              void window.workbench.setThemeMode(event.target.value as ThemeMode).then((state) => { setWindowState(state); document.documentElement.dataset.theme = state.colorScheme; }).catch(() => setThemeError("无法切换外观，请重试。"));
            }}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          {themeError && <p role="alert">{themeError}</p>}
        </>
      }
      center={
        <div className="hc208-center">
          {selected ? (
            <>
              <div className="hc208-tabs" role="tablist" aria-label="预览页签">
                <button
                  role="tab"
                  aria-selected={!central}
                  onClick={() => setCentral(false)}
                >
                  对话
                </button>
                {fileOpened && (
                  <ProjectFileTab
                    scope={scope}
                    path="README.md"
                    name="README.md"
                    selected={central}
                    tabId="file-tab"
                    panelId="file-panel"
                    onActivate={() => setCentral(true)}
                    onClose={() => {
                      setCentral(false);
                      setFileOpened(false);
                    }}
                  />
                )}
              </div>
              <div
                className="hc208-conversation"
                hidden={central}
                inert={central}
              >
                <ConversationView
                  scope={{
                    namespace: scope.namespace,
                    accountId: scope.accountId,
                    workspaceId: scope.workspaceId,
                    conversationId: session.id,
                  }}
                  visible={!central}
                  entries={[
                    {
                      kind: "message",
                      id: "one",
                      role: "user",
                      author: { id: "user-1", displayName: "用户甲" },
                      text: "这是一条受控的协作会话。",
                    },
                  ]}
                  contentRevision={1}
                  composer={{
                    send: disabled,
                    cancel: disabled,
                    primaryActions: "none",
                    commands: [],
                    controls: [],
                    projectTarget: null,
                    references: [],
                    attachments: [],
                  }}
                  interaction={null}
                  personal={personal}
                  actions={{ onPersonalChange: updatePersonal }}
                />
              </div>
              {fileOpened && (
                <ProjectFilePanel
                  scope={scope}
                  path="README.md"
                  view={file}
                  refresh={disabled}
                  onRefresh={() => {}}
                  active={central}
                  tabId="file-tab"
                  panelId="file-panel"
                />
              )}
            </>
          ) : (
            <p className="hc208-placeholder">从左侧选择会话</p>
          )}
        </div>
      }
      right={(slot) =>
        selected ? (
          <ProjectDock
            scope={scope}
            projectName="示例项目"
            availability={{ state: "available" }}
            tree={{
              status: "ready",
              rows: [
                {
                  path: "README.md",
                  name: "README.md",
                  kind: "file",
                  depth: 0,
                  expanded: false,
                  loading: false,
                  hasChildren: false,
                },
              ],
              limited: false,
              freshness: "cached",
            }}
            files={fileOpened ? { "README.md": file } : {}}
            changes={{
              status: "ready",
              busy: false,
              freshness: "cached",
              repository: { snapshot: "preview", branch: "preview", files: [] },
            }}
            gates={gates}
            personal={{
              ...project,
              dockOpen: slot.open,
              dockWidthPx: slot.widthPx,
            }}
            actions={{
              ...baseActions,
              setDockOpen: (_s, open) => slot.setOpen(open),
              setDockWidth: (_s, width) => slot.setWidth(width),
            }}
          />
        ) : (
          <p className="hc208-placeholder">选择会话后查看原项目</p>
        )
      }
    />
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
