/**
 * 真实脚本化 Agent 的 spawn 计划：`packages/agent/.venv` 里的 Python 跑
 * `acp_scripted_main.py`，按 `ACP_SCENARIO` 选场景。
 *
 * `.venv` 缺失时 `pythonAvailable` 为假，用例用 `describe.skipIf` 整体跳过
 * （并在输出里说明原因，不静默）。
 */

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { AcpSpawnPlan } from "../../../src/acp-command"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
export const AGENT_DIR = join(REPO_ROOT, "packages", "agent")
export const VENV_PYTHON = join(AGENT_DIR, ".venv", "bin", "python")
export const pythonAvailable = existsSync(VENV_PYTHON)

export type AcpScenario = "stub" | "host" | "tools" | "commands" | "approval" | "trust" | "diff" | "history" | "block" | "pollute" | "stubborn"

/** 临时工作区（realpath 由调用方处理）。 */
export function makePythonWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "acp-py-ws-"))
}

export function pythonAgentPlan(scenario: AcpScenario, workspace: string): AcpSpawnPlan {
  return {
    executable: VENV_PYTHON,
    args: [join(AGENT_DIR, "tests", "support", "acp_scripted_main.py")],
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      // 隔离 HOME：脚本化 Host 不碰真实用户配置。
      HOME: mkdtempSync(join(tmpdir(), "acp-py-home-")),
      PYTHONPATH: AGENT_DIR,
      ACP_SCENARIO: scenario,
      ACP_WORKSPACE: workspace,
      PYTHONSAFEPATH: "1",
      // Python 3.14 的 pydantic.v1 警告会写 stderr（不进协议通道），压掉省得噪音。
      PYTHONWARNINGS: "ignore",
    },
  }
}
