/** 安装形态与开发形态的内核进程定位。 */
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { resolveAgentProcessBinding } from "../src/runtime-binding"

test("HARNESS_AGENT_PYTHON 优先，且不注入开发 PYTHONPATH", () => {
  const binding = resolveAgentProcessBinding({
    moduleDir: "/unused/cli/src",
    env: { HARNESS_AGENT_PYTHON: "/opt/custom/python", PATH: "/opt/bin" },
    exists: () => false,
  })
  expect(binding.argv).toEqual(["/opt/custom/python", "-m", "harness_agent"])
  expect(binding.pythonPath).toBeUndefined()
})

test("PATH 上的 harness-agent 用于安装形态，不设开发 PYTHONPATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-binding-path-"))
  const bin = join(root, "bin")
  const agent = join(bin, "harness-agent")
  await mkdir(bin)
  await writeFile(agent, "")
  const binding = resolveAgentProcessBinding({
    moduleDir: join(root, "cli/src"),
    env: { PATH: bin },
  })
  expect(binding.argv).toEqual([agent])
  expect(binding.pythonPath).toBeUndefined()
})

test("Windows 可执行文件名 harness-agent.exe 可被解析", () => {
  const binding = resolveAgentProcessBinding({
    moduleDir: "/unused",
    env: { PATH: "/tools" },
    exists: path => path === resolve("/tools", "harness-agent.exe"),
  })
  expect(binding.argv).toEqual([resolve("/tools", "harness-agent.exe")])
  expect(binding.pythonPath).toBeUndefined()
})

test("开发形态使用仓库 .venv 并注入源码 PYTHONPATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-binding-dev-"))
  const moduleDir = join(root, "packages/cli/src")
  const agentDir = join(root, "packages/agent")
  const python = join(agentDir, ".venv/bin/python")
  await mkdir(dirname(python), { recursive: true })
  await writeFile(python, "")
  const binding = resolveAgentProcessBinding({
    moduleDir,
    env: { PATH: "" },
  })
  expect(binding.argv).toEqual([python, "-m", "harness_agent"])
  expect(binding.pythonPath).toBe(agentDir)
})

test("找不到内核时失败关闭，不落到系统 python3", () => {
  expect(() => resolveAgentProcessBinding({
    moduleDir: "/missing/cli/src",
    env: { PATH: "/empty" },
    exists: () => false,
  })).toThrow("未找到 Harness 内核")
})
