/** Unix 安装器：退出码、跳过已有依赖、PATH、示例配置。 */
import { expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const installer = join(__dirname, "../../../scripts/install/install.sh")
const exampleConfig = join(__dirname, "../../../docs/user/examples/config.toml")

async function makeHome(): Promise<{ home: string; bin: string; log: string }> {
  const home = await mkdtemp(join(tmpdir(), "harness-install-"))
  const bin = join(home, "bin")
  await mkdir(bin)
  return { home, bin, log: join(home, "commands.log") }
}

async function writeExec(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
  await chmod(path, 0o755)
}

async function writeFakes(bin: string, log: string, options?: { bunVersion?: string; harnessFails?: boolean }): Promise<void> {
  const bunVersion = options?.bunVersion ?? "1.2.19"
  const harnessTemplate = join(bin, "harness-template")
  await writeExec(harnessTemplate, options?.harnessFails
    ? "#!/bin/sh\necho fail >&2\nexit 1\n"
    : "#!/bin/sh\necho 0.1.0\n")
  await writeExec(join(bin, "bun"), `#!/bin/sh
echo "bun $*" >> "${log}"
if [ "$1" = "--version" ]; then echo "${bunVersion}"; exit 0; fi
if [ "$1" = "install" ]; then
  mkdir -p "$HOME/.bun/bin"
  cp "${harnessTemplate}" "$HOME/.bun/bin/harness"
  chmod +x "$HOME/.bun/bin/harness"
  exit 0
fi
exit 1
`)
  await writeExec(join(bin, "uv"), `#!/bin/sh
echo "uv $*" >> "${log}"
if [ "$1" = "python" ] && [ "$2" = "find" ]; then echo "$HOME/python3"; exit 0; fi
if [ "$1" = "tool" ] && [ "$2" = "install" ]; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\\necho agent\\n' > "$HOME/.local/bin/harness-agent"
  chmod +x "$HOME/.local/bin/harness-agent"
  exit 0
fi
exit 1
`)
  await writeExec(join(bin, "curl"), `#!/bin/sh
echo "curl $*" >> "${log}"
exit 1
`)
}

function runInstaller(home: string, bin: string, args: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync("bash", [installer, ...args], {
    cwd: home,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      SHELL: "/bin/zsh",
      HARNESS_EXAMPLE_CONFIG: exampleConfig,
      HARNESS_NPM_REGISTRY: "https://registry.test.example/npm",
      UV_INDEX_URL: "https://pypi.test.example/simple",
      ...extraEnv,
    },
    encoding: "utf8",
  })
  return {
    exitCode: res.status ?? 1,
    stdout: Buffer.from(res.stdout || ""),
    stderr: Buffer.from(res.stderr || ""),
  }
}

test("未填写企业包源时安装失败并提示填写 DEFAULT_*", async () => {
  const { home, bin, log } = await makeHome()
  await writeFakes(bin, log)
  const result = runInstaller(home, bin, ["--no-modify-path"], {
    HARNESS_NPM_REGISTRY: "",
    UV_INDEX_URL: "",
  })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString() + result.stdout.toString()).toContain("DEFAULT_NPM_REGISTRY")
})

test("未知参数退出 2 并打印用法", async () => {
  const { home, bin } = await makeHome()
  const result = runInstaller(home, bin, ["--nope"])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString() + result.stdout.toString()).toContain("Usage")
})

test("--help 退出 0", async () => {
  const { home, bin } = await makeHome()
  const result = runInstaller(home, bin, ["--help"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("Usage")
})

test("不支持的架构退出 1", async () => {
  const { home, bin } = await makeHome()
  const result = runInstaller(home, bin, [], { HARNESS_INSTALL_ARCH: "riscv64" })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString() + result.stdout.toString()).toContain("riscv64")
})

test("musl 退出 1 并说明不支持", async () => {
  const { home, bin } = await makeHome()
  const result = runInstaller(home, bin, [], { HARNESS_INSTALL_LIBC: "musl" })
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString() + result.stdout.toString()).toMatch(/musl/i)
})

test("已有合格 Bun 时不下载 bun", async () => {
  const { home, bin, log } = await makeHome()
  await writeFakes(bin, log)
  const result = runInstaller(home, bin, ["--no-modify-path"])
  expect(result.exitCode).toBe(0)
  const recorded = await readFile(log, "utf8")
  expect(recorded).not.toContain("curl")
  expect(recorded).toContain("bun install")
  expect(recorded).toContain("--registry https://registry.test.example/npm")
  expect(recorded).toContain("uv tool install")
  expect(recorded).toContain("--index https://pypi.test.example/simple")
})

test("harness --version 失败则退出 1 且不宣称成功", async () => {
  const { home, bin, log } = await makeHome()
  await writeFakes(bin, log, { harnessFails: true })
  const result = runInstaller(home, bin, ["--no-modify-path"])
  expect(result.exitCode).toBe(1)
  expect(result.stdout.toString()).not.toContain("安装成功")
})

test("--no-modify-path 不改 shell rc", async () => {
  const { home, bin, log } = await makeHome()
  await writeFakes(bin, log)
  const zshrc = join(home, ".zshrc")
  await writeFile(zshrc, "# keep\n")
  const result = runInstaller(home, bin, ["--no-modify-path"])
  expect(result.exitCode).toBe(0)
  expect(await readFile(zshrc, "utf8")).toBe("# keep\n")
})

test("没有配置时写入示例且不含字面量密钥，已有配置不覆盖", async () => {
  const { home, bin, log } = await makeHome()
  await writeFakes(bin, log)
  const first = runInstaller(home, bin, ["--no-modify-path"])
  expect(first.exitCode).toBe(0)
  const configPath = join(home, ".harness/config.toml")
  const firstText = await readFile(configPath, "utf8")
  expect(firstText).toContain("api_key_env")
  expect(firstText.split("\n").filter(line => /^\s*api_key\s*=/.test(line))).toEqual([])
  const marker = "# user-owned\n"
  await writeFile(configPath, marker)
  const second = runInstaller(home, bin, ["--no-modify-path"])
  expect(second.exitCode).toBe(0)
  expect(await readFile(configPath, "utf8")).toBe(marker)
})
