import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const loopbackTest = process.env.HARNESS_RUN_LOOPBACK_E2E === "1" ? test : test.skip

loopbackTest("CLI, Python sidecar, and OpenAI-compatible streaming gateway work end to end", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
    expect(payload.stream).toBe(true)
    const events = [
      {
        id: "mock",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: { role: "assistant", content: "gateway response" }, finish_reason: null }],
      },
      {
        id: "mock",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Mock gateway did not expose a TCP address")

  const configDirectory = await mkdtemp(resolve(tmpdir(), "za38-gateway-e2e-"))
  const configPath = resolve(configDirectory, "config.toml")
  await writeFile(
    configPath,
    `[config]
version = 1

[models]
default_profile = "mock"

[models.profiles.mock]
provider = "openai-compatible"
model = "mock"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key_env = "HARNESS_TEST_KEY"
`,
  )
  const packageDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
  const agentDir = resolve(packageDir, "../agent")
  try {
    const child = spawn(
      process.execPath,
      ["dist/index.js", "--non-interactive", "say hello", "--json", "--config", configPath],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          // E2E 只验证传入的 v1 配置，不能受开发机用户级配置污染。
          HOME: resolve(configDirectory, "home"),
          HARNESS_AGENT_PYTHON: resolve(agentDir, ".venv/bin/python"),
          PYTHONPATH: agentDir,
          HARNESS_TEST_KEY: "test-key",
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

    const exitCode = await new Promise(resolve => child.on("close", resolve))
    if (exitCode !== 0) throw new Error(`CLI exited with ${exitCode}: ${stderr}`)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout)).toMatchObject({ text: "gateway response", usage: { input_tokens: 3, output_tokens: 2 } })
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    await rm(configDirectory, { recursive: true, force: true })
  }
})
