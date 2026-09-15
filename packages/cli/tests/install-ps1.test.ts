/** Windows 安装器：与 install.sh 同一语义，可在无 pwsh 的机器上做脚本契约测试。 */
import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const installer = join(import.meta.dir, "../../../scripts/install/install.ps1")

test("install.ps1 存在并拒绝非 PowerShell 宿主与未知参数", async () => {
  const src = await readFile(installer, "utf8")
  expect(src).toContain("Please run this installer in PowerShell")
  expect(src).toMatch(/HARNESS_INSTALL_SHELL/)
  expect(src).toMatch(/Fail 2|exit\s+2/)
  expect(src).toContain("Usage")
  expect(src).toContain("--no-modify-path")
})

test("install.ps1 拒绝 Windows ARM 与 musl 同类不支持矩阵", async () => {
  const src = await readFile(installer, "utf8")
  expect(src).toMatch(/Windows ARM is not supported/i)
  expect(src).toMatch(/ARM64|arm64/)
})

test("install.ps1 PATH 含 bun 与 uv tool bin，便于解析 harness-agent.exe", async () => {
  const src = await readFile(installer, "utf8")
  expect(src).toContain(".bun")
  expect(src).toContain(".local")
  expect(src).toMatch(/harness --version/)
  expect(src).toContain("HARNESS_NPM_REGISTRY")
  expect(src).toContain("UV_INDEX_URL")
  expect(src).toContain("HARNESS_EXAMPLE_CONFIG")
  expect(src).toContain("$DefaultNpmRegistry")
  expect(src).toContain("$DefaultPypiIndex")
  expect(src).not.toContain("za38.com")
})

test("若本机有 pwsh 则未知参数退出 2、--help 退出 0、cmd 宿主退出 1", async () => {
  const pwsh = Bun.which("pwsh") ?? Bun.which("powershell")
  if (!pwsh) {
    return
  }
  const help = Bun.spawnSync([pwsh, "-NoProfile", "-File", installer, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(help.exitCode).toBe(0)
  expect(help.stdout.toString() + help.stderr.toString()).toContain("Usage")

  const unknown = Bun.spawnSync([pwsh, "-NoProfile", "-File", installer, "--nope"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(unknown.exitCode).toBe(2)

  const cmdHost = Bun.spawnSync([pwsh, "-NoProfile", "-File", installer], {
    env: { ...process.env, HARNESS_INSTALL_SHELL: "cmd" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(cmdHost.exitCode).toBe(1)
  expect(cmdHost.stderr.toString() + cmdHost.stdout.toString()).toContain("PowerShell")
})
