import type { CollaborationHost, DesktopHost, DeviceHost } from "@workbench/contracts"

declare global {
  interface Window { workbench: DesktopHost; collaboration: CollaborationHost; devices: DeviceHost }
}
