import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

test("CLI starts the Python sidecar and returns a completed JSON run", async () => {
  const packageDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
  const agentDir = resolve(packageDir, "../agent")
  const child = spawn(
    process.execPath,
    ["dist/index.js", "--non-interactive", "hello from cli", "--json"],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        HARNESS_ECHO_MODE: "1",
        HARNESS_AGENT_PYTHON: resolve(agentDir, ".venv/bin/python"),
        PYTHONPATH: agentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", chunk => { stdout += chunk })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", chunk => { stderr += chunk })

  const exitCode = await new Promise(resolveClose => child.on("close", resolveClose))
  expect(exitCode).toBe(0)
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toMatchObject({ text: "hello from cli", usage: { input_tokens: 0, output_tokens: 0 } })
}, 15_000)
