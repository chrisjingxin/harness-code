import type { CollaborationHost, DesktopHost, DeviceHost, ProjectConversationHost } from "@workbench/contracts"
import type { PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"

declare global {
  interface Window {
    workbench: DesktopHost
    collaboration: CollaborationHost
    projectConversations: ProjectConversationHost
    devices: DeviceHost
    personal: PersonalHost
    organization: OrganizationHost
  }
}
