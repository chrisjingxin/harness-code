/** 可发布 CLI 副本只含 dist、关闭 private、不含 tests 与 protocol workspace。 */
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { packPublishableCli, publishableCliManifest, stagePublishableCli } from "../scripts/pack-publishable"
import { resolveAgentProcessBinding } from "../src/runtime-binding"

test("发布 manifest 关闭 private、只带 dist、去掉已打包的 protocol", () => {
  const manifest = publishableCliManifest({
    name: "@za38/cli",
    version: "0.1.0",
    type: "module",
    bin: { harness: "./dist/index.js", za38: "./dist/index.js" },
    dependencies: {
      "@colbymchenry/codegraph": "1.1.6",
      "@opentui/core": "0.4.3",
      "@za38/protocol": "workspace:*",
      react: "19.2.6",
    },
  })
  expect(manifest.private).toBe(false)
  expect(manifest.files).toEqual(["dist"])
  expect(manifest.bin).toEqual({ harness: "./dist/index.js", za38: "./dist/index.js" })
  expect(manifest.dependencies).toEqual({
    "@colbymchenry/codegraph": "1.1.6",
    "@opentui/core": "0.4.3",
    react: "19.2.6",
  })
})

test("CLI manifest 精确锁定代码索引运行时 1.1.6", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json()
  expect(manifest.dependencies?.["@colbymchenry/codegraph"]).toBe("1.1.6")
})

test("发布副本含 dist 运行资产且不含 tests", async () => {
  const cliRoot = join(import.meta.dir, "..")
  const stagingDir = await mkdtemp(join(tmpdir(), "harness-cli-stage-"))
  const staged = await stagePublishableCli(cliRoot, stagingDir)
  expect(staged.packageJson.private).toBe(false)
  expect(staged.packageJson.files).toEqual(["dist"])
  expect(staged.packageJson.dependencies["@za38/protocol"]).toBeUndefined()
  const distIndex = Bun.file(join(stagingDir, "dist/index.js"))
  const webAssets = Bun.file(join(stagingDir, "dist/web-assets.json"))
  expect(await distIndex.exists()).toBe(true)
  expect(await webAssets.exists()).toBe(true)
  expect(await Bun.file(join(stagingDir, "dist/code-index-adapter/index.mjs")).exists()).toBe(true)
  expect(await Bun.file(join(stagingDir, "tests/index.test.ts")).exists()).toBe(false)
  expect(await Bun.file(join(stagingDir, "src/index.ts")).exists()).toBe(false)
})

test("tarball 含 dist 运行资产且不含 tests 或源码", async () => {
  const cliRoot = join(import.meta.dir, "..")
  const outDir = await mkdtemp(join(tmpdir(), "harness-cli-pack-"))
  const tarball = await packPublishableCli(cliRoot, outDir)
  expect(await Bun.file(tarball).exists()).toBe(true)
  const listed = Bun.spawnSync(["tar", "-tzf", tarball], { stdout: "pipe", stderr: "pipe" })
  expect(listed.exitCode).toBe(0)
  const names = listed.stdout.toString()
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
  const agentRoot = join(import.meta.dir, "../../agent")
  const python = join(agentRoot, ".venv/bin/python")
  const out = await mkdtemp(join(tmpdir(), "harness-b3-wheel-"))
  const built = Bun.spawnSync(["uv", "build", "--wheel", "--out-dir", out], {
    cwd: agentRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(built.exitCode).toBe(0)
  const wheelName = (await readdir(out)).find(name => name.startsWith("za38_agent-") && name.endsWith(".whl"))
  expect(wheelName).toBeString()
  const wheel = join(out, wheelName!)
  const prefix = join(out, "prefix")
  const installed = Bun.spawnSync(["uv", "pip", "install", "--python", python, "--no-deps", "--prefix", prefix, wheel!], {
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(installed.exitCode).toBe(0)
  const script = join(prefix, "bin/harness-agent")
  expect(await Bun.file(script).exists()).toBe(true)
  const binding = resolveAgentProcessBinding({
    moduleDir: join(out, "cli/src"),
    env: { PATH: join(prefix, "bin") },
  })
  expect(binding.argv).toEqual([script])
  expect(binding.pythonPath).toBeUndefined()
})
