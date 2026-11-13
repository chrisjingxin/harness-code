import type { CollaborationHost, ConversationReadHost, DesktopHost, DeviceHost } from "@workbench/contracts"
import type { ProjectReadHost } from "../project-read-host.js"
import type { PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"

declare global {
  interface Window { workbench: DesktopHost; collaboration: CollaborationHost; conversations: ConversationReadHost; devices: DeviceHost; projects: ProjectReadHost; personal: PersonalHost; organization: OrganizationHost }
}
