/** 可发布 CLI 副本只含 dist、关闭 private、不含 tests 与 protocol workspace。 */
import { expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { packPublishableCli, publishableCliManifest, stagePublishableCli } from "../scripts/pack-publishable"
import { resolveAgentProcessBinding } from "../src/runtime-binding"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

test("发布 manifest 关闭 private、只带 dist、去掉已打包的 protocol", () => {
  const manifest = publishableCliManifest({
    name: "@za38/cli",
    version: "0.1.0",
    type: "module",
    bin: { harness: "./dist/index.js", za38: "./dist/index.js" },
    dependencies: {
      "@colbymchenry/codegraph": "1.1.6",
      marked: "17.0.1",
      "@za38/protocol": "workspace:*",
      react: "19.2.6",
    },
  })
  expect(manifest.private).toBe(false)
  expect(manifest.files).toEqual(["dist"])
  expect(manifest.bin).toEqual({ harness: "./dist/index.js", za38: "./dist/index.js" })
  expect(manifest.dependencies).toEqual({
    "@colbymchenry/codegraph": "1.1.6",
    marked: "17.0.1",
    react: "19.2.6",
  })
})

test("CLI manifest 精确锁定代码索引运行时 1.1.6", async () => {
  const manifest = JSON.parse(await readFile(join(__dirname, "../package.json"), "utf8"))
  expect(manifest.dependencies?.["@colbymchenry/codegraph"]).toBe("1.1.6")
})

test("发布副本含 dist 运行资产且不含 tests", async () => {
  const cliRoot = join(__dirname, "..")
  const stagingDir = await mkdtemp(join(tmpdir(), "harness-cli-stage-"))
  const staged = await stagePublishableCli(cliRoot, stagingDir)
  expect(staged.packageJson.private).toBe(false)
  expect(staged.packageJson.files).toEqual(["dist"])
  expect(staged.packageJson.dependencies["@za38/protocol"]).toBeUndefined()
  expect(existsSync(join(stagingDir, "dist/index.js"))).toBe(true)
  expect(existsSync(join(stagingDir, "dist/web-assets.json"))).toBe(true)
  expect(existsSync(join(stagingDir, "dist/code-index-adapter/index.mjs"))).toBe(true)
  expect(existsSync(join(stagingDir, "tests/index.test.ts"))).toBe(false)
  expect(existsSync(join(stagingDir, "src/index.ts"))).toBe(false)
})

test("tarball 含 dist 运行资产且不含 tests 或源码", async () => {
  const cliRoot = join(__dirname, "..")
  const outDir = await mkdtemp(join(tmpdir(), "harness-cli-pack-"))
  const tarball = await packPublishableCli(cliRoot, outDir)
  expect(existsSync(tarball)).toBe(true)
  const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" })
  expect(listed.status).toBe(0)
  const names = listed.stdout
  expect(names).toContain("dist/index.js")
  expect(names).toContain("dist/web-assets.json")
  expect(names).toContain("dist/code-index-adapter/index.mjs")
  expect(names).not.toContain("tests/")
  expect(names).not.toContain("src/index.ts")
  expect(names).not.toContain("node_modules/")
})

test("隔离 PATH 上的已安装 harness-agent 不会回退到开发 .venv", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-b3-bind-"))
  const bin = join(root, "bin")
  const agent = join(bin, "harness-agent")
  await mkdir(bin)
  await writeFile(agent, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const binding = resolveAgentProcessBinding({
    moduleDir: join(root, "somewhere/cli/src"),
    env: { PATH: bin },
  })
  expect(binding.argv).toEqual([agent])
  expect(binding.pythonPath).toBeUndefined()
})

test("本地 wheel 装到隔离 prefix 后 PATH 解析到 harness-agent", async () => {
  const agentRoot = join(__dirname, "../../agent")
  const python = join(agentRoot, ".venv/bin/python")
  const out = await mkdtemp(join(tmpdir(), "harness-b3-wheel-"))
  const built = spawnSync("uv", ["build", "--wheel", "--out-dir", out], {
    cwd: agentRoot,
    encoding: "utf8",
  })
  expect(built.status).toBe(0)
  const wheelName = (await readdir(out)).find(name => name.startsWith("za38_agent-") && name.endsWith(".whl"))
  expect(typeof wheelName).toBe("string")
  const wheel = join(out, wheelName!)
  const prefix = join(out, "prefix")
  const installed = spawnSync("uv", ["pip", "install", "--python", python, "--no-deps", "--prefix", prefix, wheel!], {
    encoding: "utf8",
  })
  expect(installed.status).toBe(0)
  const script = join(prefix, "bin/harness-agent")
  expect(existsSync(script)).toBe(true)
  const binding = resolveAgentProcessBinding({
    moduleDir: join(out, "cli/src"),
    env: { PATH: join(prefix, "bin") },
  })
  expect(binding.argv).toEqual([script])
  expect(binding.pythonPath).toBeUndefined()
}, 30_000)

test("tarball 可在隔离 prefix 安装并在无 dev 依赖下运行 --version", async () => {
  const cliRoot = join(__dirname, "..")
  const packDir = await mkdtemp(join(tmpdir(), "harness-pack-e2e-"))
  const tarball = await packPublishableCli(cliRoot, packDir)
  const installPrefix = await mkdtemp(join(tmpdir(), "harness-install-prefix-"))
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: installPrefix,
    encoding: "utf8",
    timeout: 60_000,
  })
  expect(install.status).toBe(0)
  const harnessBin = join(installPrefix, "node_modules/.bin/harness")
  const run = spawnSync(harnessBin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  })
  expect(run.status).toBe(0)
  expect(run.stdout.trim()).toBe("0.1.0")
}, 80_000)
