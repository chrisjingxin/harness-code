import type { CollaborationHost, DesktopHost } from "@workbench/contracts"

declare global {
  interface Window { workbench: DesktopHost; collaboration: CollaborationHost }
}
