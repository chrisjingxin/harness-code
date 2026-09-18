/** Windows 安装器：与 install.sh 同一语义，可在无 pwsh 的机器上做脚本契约测试。 */
import { expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const installer = join(__dirname, "../../../scripts/install/install.ps1")

function findPwsh(): string | null {
  for (const bin of ["pwsh", "powershell"]) {
    const res = spawnSync("which", [bin], { encoding: "utf8" })
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim()
    }
  }
  return null
}

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
  const pwsh = findPwsh()
  if (!pwsh) {
    return
  }
  const help = spawnSync(pwsh, ["-NoProfile", "-File", installer, "--help"], {
    encoding: "utf8",
  })
  expect(help.status).toBe(0)
  expect((help.stdout || "") + (help.stderr || "")).toContain("Usage")

  const unknown = spawnSync(pwsh, ["-NoProfile", "-File", installer, "--nope"], {
    encoding: "utf8",
  })
  expect(unknown.status).toBe(2)

  const cmdHost = spawnSync(pwsh, ["-NoProfile", "-File", installer], {
    env: { ...process.env, HARNESS_INSTALL_SHELL: "cmd" },
    encoding: "utf8",
  })
  expect(cmdHost.status).toBe(1)
  expect((cmdHost.stderr || "") + (cmdHost.stdout || "")).toContain("PowerShell")
})
