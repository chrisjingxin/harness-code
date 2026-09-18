/** Node/Vitest 测试配置 */
import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: [
      "scripts/project/**/*.test.ts",
      "packages/cli/tests/**/*.test.{ts,tsx}",
    ],
  },
})
