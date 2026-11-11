/** 项目文件视图出口；共享根出口由统筹顺序集成。 */
export { ProjectDock } from "./project-dock.js"
export { ProjectFilePanel, ProjectFileTab } from "./file-view.js"
export type { ProjectFilePanelProps, ProjectFileTabProps } from "./file-view.js"
export type {
  ProjectScope, ProjectAvailability, ProjectActionAvailability, ProjectTreeRow, ProjectTreeView,
  ProjectFileContent, ProjectFileView, ProjectChangedFile, ProjectChangesView, ProjectGates,
  ProjectPersonalView, ProjectActions, ProjectDockProps,
} from "./types.js"
