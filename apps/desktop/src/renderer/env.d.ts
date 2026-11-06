import type { DesktopHost } from "@workbench/contracts"

declare global {
  interface Window { workbench: DesktopHost }
}
