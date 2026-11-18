/** Harness Provider 描述符、命令探测与 `_meta.harnessCode` 解析测试。 */
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  HARNESS_CLIENT_EXTENSION_CAPABILITIES,
  HARNESS_HOST_HINTS,
  harnessProviderDescriptor,
  parseHarnessAgentCapabilitiesMeta,
  parseHarnessApprovalMeta,
  parseHarnessCommandMeta,
  parseHarnessParentMeta,
  parseHarnessRunMeta,
  parseHarnessSessionSummaryMeta,
  resolveHarnessCommand,
} from "../dist/index.js"

async function makeExecutable(filePath: string, content = "#!/bin/sh\nexit 0\n"): Promise<void> {
  await writeFile(filePath, content, "utf8")
  if (process.platform !== "win32") await chmod(filePath, 0o755)
}

test("Harness 客户端提示开启 elicitation 与 fs 能力，并导出完整扩展能力声明", () => {
  assert.equal(harnessProviderDescriptor.id, "harness")
  assert.equal(HARNESS_HOST_HINTS.enableElicitation, true)
  assert.equal(HARNESS_HOST_HINTS.enableClientFs, true)
  assert.equal(HARNESS_HOST_HINTS.restorePolicy, "fallback-new")
  assert.equal(HARNESS_CLIENT_EXTENSION_CAPABILITIES.version, 1)
  assert.ok(HARNESS_CLIENT_EXTENSION_CAPABILITIES.capabilities.includes("approval"))
  assert.ok(HARNESS_CLIENT_EXTENSION_CAPABILITIES.capabilities.includes("goal"))
})

test("resolveHarnessCommand 按 .venv/bin/harness-agent -> .venv python -m -> PATH 顺序探测", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-harness-prov-"))
  try {
    const isWin = process.platform === "win32"
    const agentDir = join(root, "repo", "packages", "agent")
    const venvBin = join(agentDir, ".venv", isWin ? "Scripts" : "bin")
    const agentPkg = join(agentDir, "harness_agent")
    const pathDir = join(root, "path-bin")
    await Promise.all([
      mkdir(venvBin, { recursive: true }),
      mkdir(agentPkg, { recursive: true }),
      mkdir(pathDir, { recursive: true }),
    ])

    // 1) 未找到任何可执行入口
    const missing = resolveHarnessCommand({ PATH: pathDir }, { searchFrom: [join(root, "repo")], includeDefaultGuiPath: false })
    assert.equal(missing.available, false)

    // 2) PATH 中的 harness-agent
    const pathCli = join(pathDir, isWin ? "harness-agent.exe" : "harness-agent")
    await makeExecutable(pathCli)
    const fromPath = resolveHarnessCommand({ PATH: pathDir }, { searchFrom: [join(root, "repo")], includeDefaultGuiPath: false })
    assert.equal(fromPath.available, true)
    if (fromPath.available) {
      assert.equal(fromPath.source, "path")
      assert.deepEqual(fromPath.command.args, ["acp"])
    }

    // 3) .venv/bin/python3 -m harness_agent acp 优先于 PATH
    await writeFile(join(agentPkg, "__main__.py"), "print('ok')\n", "utf8")
    const py3 = join(venvBin, isWin ? "python.exe" : "python3")
    await makeExecutable(py3)
    const fromPy = resolveHarnessCommand({ PATH: pathDir }, { searchFrom: [join(root, "repo")], includeDefaultGuiPath: false })
    assert.equal(fromPy.available, true)
    if (fromPy.available) {
      assert.equal(fromPy.source, "venv-python")
      assert.equal(fromPy.command.executable, py3)
      assert.deepEqual(fromPy.command.args, ["-m", "harness_agent", "acp"])
      assert.equal(fromPy.command.env?.PYTHONSAFEPATH, "1")
      assert.equal(fromPy.command.env?.PYTHONPATH, agentDir)
    }

    // 4) .venv/bin/harness-agent 最优先
    const venvCli = join(venvBin, isWin ? "harness-agent.exe" : "harness-agent")
    await makeExecutable(venvCli)
    const fromVenvCli = resolveHarnessCommand({ PATH: pathDir }, { searchFrom: [join(root, "repo")], includeDefaultGuiPath: false })
    assert.equal(fromVenvCli.available, true)
    if (fromVenvCli.available) {
      assert.equal(fromVenvCli.source, "venv-cli")
      assert.equal(fromVenvCli.command.executable, venvCli)
      assert.deepEqual(fromVenvCli.command.args, ["acp"])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("_meta.harnessCode 解析辅助函数安全提取工作流/计划/目标/思考/命令与审批元数据", () => {
  assert.deepEqual(
    parseHarnessAgentCapabilitiesMeta({ _meta: { harnessCode: { version: 1, capabilities: ["approval", "goal", 123] } } }),
    { version: 1, capabilities: ["approval", "goal"] },
  )
  assert.equal(parseHarnessAgentCapabilitiesMeta({ _meta: { harnessCode: { version: 2, capabilities: [] } } }), undefined)

  assert.deepEqual(
    parseHarnessCommandMeta({
      harnessCode: {
        id: "builtin/goal",
        source: "builtin",
        requestedSkillId: "skill:demo",
        pluginId: "plugin-a",
        ephemeral: true,
        command: { name: "undo", historyChanged: true },
      },
    }),
    {
      id: "builtin/goal",
      source: "builtin",
      requestedSkillId: "skill:demo",
      pluginId: "plugin-a",
      ephemeral: true,
      commandName: "undo",
      historyChanged: true,
    },
  )

  assert.deepEqual(
    parseHarnessApprovalMeta({
      harnessCode: {
        approval: { type: "directory_trust", requestId: "req-1", description: "访问外部目录" },
        scope: "thread",
      },
    }),
    { type: "directory_trust", requestId: "req-1", description: "访问外部目录", scope: "thread" },
  )

  assert.deepEqual(
    parseHarnessParentMeta({
      harnessCode: { parent: { toolCallId: "t-1", executionId: "e-1", agentId: "sub-1" } },
    }),
    { toolCallId: "t-1", executionId: "e-1", agentId: "sub-1" },
  )
  assert.equal(parseHarnessParentMeta({ harnessCode: { parent: { toolCallId: "t-1" } } }), undefined)

  assert.deepEqual(
    parseHarnessRunMeta({
      harnessCode: {
        run: {
          usage: { input_tokens: 100, output_tokens: 40, cached_tokens: 20 },
          duration_ms: 850,
          context: { workflow: "compose", plan: { id: "p1" }, goal: { objective: "ok" }, thinking: "enabled" },
        },
      },
    }),
    {
      usage: { inputTokens: 100, outputTokens: 40, cachedTokens: 20 },
      durationMs: 850,
      workflow: "compose",
      plan: { id: "p1" },
      goal: { objective: "ok" },
      thinking: "enabled",
      context: { workflow: "compose", plan: { id: "p1" }, goal: { objective: "ok" }, thinking: "enabled" },
    },
  )

  assert.deepEqual(
    parseHarnessSessionSummaryMeta({ harnessCode: { summary: { brief: "已完成", turns: 3 } } }),
    { brief: "已完成", turns: 3 },
  )
  assert.equal(parseHarnessSessionSummaryMeta(null), undefined)
})
