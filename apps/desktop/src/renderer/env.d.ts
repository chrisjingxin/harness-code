import type {
  CollaborationAppsHost, CollaborationHost, DesktopHost, LocalDirectoryHost, OrganizationHost, PersonalHost,
  ProjectConversationHost, ProjectUpdatesHost,
} from "@workbench/contracts"
import type { DesktopLocalExecutionHost } from "../local-execution-host.js"

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
