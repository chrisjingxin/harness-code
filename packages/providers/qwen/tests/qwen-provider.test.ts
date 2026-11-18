/** Qwen Provider 描述符与增强 GUI PATH 探测测试。 */
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { buildAugmentedGuiPath, qwenProviderDescriptor, resolveQwenCommand } from "../dist/index.js"

async function makeExecutable(filePath: string): Promise<void> {
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8")
  if (process.platform !== "win32") await chmod(filePath, 0o755)
}

test("qwenProviderDescriptor 声明标准 ACP 启动契约", () => {
  assert.equal(qwenProviderDescriptor.id, "qwen")
  assert.equal(qwenProviderDescriptor.family, "qwen")
  assert.equal(qwenProviderDescriptor.hostHints.enableElicitation, true)
  assert.equal(qwenProviderDescriptor.hostHints.enableClientFs, true)
  assert.equal(qwenProviderDescriptor.hostHints.restorePolicy, "fallback-new")
})

test("resolveQwenCommand 使用增强 GUI PATH 查找 qwen 并传 --acp 参数", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-qwen-prov-"))
  try {
    const guiBin = join(root, "homebrew", "bin")
    const fakeHome = join(root, "home")
    await Promise.all([
      mkdir(guiBin, { recursive: true }),
      mkdir(fakeHome, { recursive: true }),
    ])
    const isWin = process.platform === "win32"
    const exePath = join(guiBin, isWin ? "qwen.cmd" : "qwen")
    await makeExecutable(exePath)

    const augmented = buildAugmentedGuiPath({ PATH: "" }, { homeDir: fakeHome, includeDefaultGuiPath: true })
    assert.ok(augmented.includes(join(fakeHome, ".local", "bin")))
    if (process.platform !== "win32") {
      assert.ok(augmented.includes("/opt/homebrew/bin"))
      assert.ok(augmented.includes("/usr/local/bin"))
      assert.ok(augmented.includes("/usr/bin"))
    }

    const res = resolveQwenCommand(
      { PATH: "" },
      { includeDefaultGuiPath: false, extraPathDirs: [guiBin] },
    )
    assert.equal(res.available, true)
    if (res.available) {
      assert.equal(res.command.executable, await realpath(exePath))
      assert.deepEqual(res.command.args, ["--acp"])
      assert.ok(res.command.env?.PATH?.includes(guiBin))
    }

    const missing = resolveQwenCommand({ PATH: join(root, "empty") }, { includeDefaultGuiPath: false })
    assert.equal(missing.available, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
