import type { CollaborationHost, DesktopHost, DeviceHost, LocalDirectoryHost, ProjectConversationHost } from "@workbench/contracts"
import type { PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"
import type { DesktopLocalExecutionHost } from "../local-execution-host.js"

declare module "*.jpg" {
  const src: string
  export default src
}

declare global {
  interface Window {
    workbench: DesktopHost
    collaboration: CollaborationHost
    projectConversations: ProjectConversationHost
    localDirectory: LocalDirectoryHost
    localExecution: DesktopLocalExecutionHost
    devices: DeviceHost
    personal: PersonalHost
    organization: OrganizationHost
  }
}
