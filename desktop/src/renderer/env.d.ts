import type { CollaborationHost } from "@workbench/collaboration-client/types"
import type {
  CollaborationAppsHost, DesktopHost, DesktopLocalExecutionHost, LocalDirectoryHost, OrganizationHost, PersonalHost,
  ProjectConversationHost, ProjectUpdatesHost,
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
    projectConversations: ProjectConversationHost
    localDirectory: LocalDirectoryHost
    localExecution: DesktopLocalExecutionHost
    personal: PersonalHost
    organization: OrganizationHost
  }
}
