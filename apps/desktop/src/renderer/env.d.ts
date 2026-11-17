import type { CollaborationHost, DesktopHost, LocalDirectoryHost, ProjectConversationHost } from "@workbench/contracts"
import type { PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"
import type { DesktopLocalExecutionHost } from "../local-execution-host.js"
import type { CollaborationAppsHost } from "../collaboration-apps-host.js"
import type { ProjectUpdatesHost } from "../project-updates-host.js"

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
