import type { CollaborationHost } from "@workbench/collaboration-client/types"
import type {
  CollaborationAppsHost, DesktopHost, DesktopLocalExecutionHost, InboxHost, LocalConversationsHost, LocalDirectoryHost, OrganizationHost, PersonalHost,
  ProjectConversationHost, ProjectUpdatesHost, WorkbenchContextHost,
} from "../shared/index.js"

declare module "*.jpg" {
  const src: string
  export default src
}

declare global {
  interface Window {
    workbench: DesktopHost
    collaboration: CollaborationHost
    collaborationApps: CollaborationAppsHost
    projectUpdates: ProjectUpdatesHost
    inbox?: InboxHost
    projectConversations: ProjectConversationHost
    localConversations: LocalConversationsHost
    localDirectory: LocalDirectoryHost
    localExecution: DesktopLocalExecutionHost
    workbenchContext: WorkbenchContextHost
    personal: PersonalHost
    organization: OrganizationHost
  }
}
