/** Node/Vitest 迁移期配置：只收集已从 bun:test 迁出的用例。 */
import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: [
      "scripts/project/**/*.test.ts",
      "packages/cli/tests/node/**/*.test.{ts,tsx}",
      "packages/cli/tests/args.test.ts",
      "packages/cli/tests/index.test.ts",
      "packages/cli/tests/runtime-binding.test.ts",
      "packages/cli/tests/diagnostic-log/**/*.test.ts",
      "packages/cli/tests/tui/adapter-runtime-input.test.ts",
    ],
  },
})
