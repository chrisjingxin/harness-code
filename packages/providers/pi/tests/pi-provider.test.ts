/** Pi Provider 描述符：增强 GUI PATH 探测 pi-acp 与真实用户 PI_CODING_AGENT_DIR 注入测试。 */
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { buildAugmentedGuiPath, piProviderDescriptor, resolvePiCommand } from "../dist/index.js"

async function makeExecutable(filePath: string): Promise<void> {
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8")
  if (process.platform !== "win32") await chmod(filePath, 0o755)
}

test("piProviderDescriptor 声明标准 ACP 能力提示与基本元数据", () => {
  assert.equal(piProviderDescriptor.id, "pi")
  assert.equal(piProviderDescriptor.family, "pi")
  assert.equal(piProviderDescriptor.hostHints.enableElicitation, true)
  assert.equal(piProviderDescriptor.hostHints.enableClientFs, true)
  assert.equal(piProviderDescriptor.hostHints.restorePolicy, "fallback-new")
})

test("resolvePiCommand 使用增强 GUI PATH 查找 pi-acp，并在未设置 PI_CODING_AGENT_DIR 时注入真实用户目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-pi-prov-"))
  try {
    const guiBin = join(root, "fake-home", ".local", "bin")
    const fakeHome = join(root, "fake-home")
    const realHome = join(root, "real-user-home")
    await Promise.all([
      mkdir(guiBin, { recursive: true }),
      mkdir(realHome, { recursive: true }),
    ])

    const isWin = process.platform === "win32"
    const binName = isWin ? "pi-acp.cmd" : "pi-acp"
    const exePath = join(guiBin, binName)
    await makeExecutable(exePath)

    // 即使 env.PATH 为空且 env.HOME 被沙盒成 fakeHome，也能通过增强 GUI PATH 找到 ~/.local/bin/pi-acp，
    // 且 PI_CODING_AGENT_DIR 使用真实用户主目录（os.userInfo().homedir/.pi/agent）。
    const augmented = buildAugmentedGuiPath({ PATH: "", HOME: fakeHome }, { homeDir: fakeHome, includeDefaultGuiPath: true })
    assert.ok(augmented.includes(guiBin))
    if (process.platform !== "win32") {
      assert.ok(augmented.includes("/opt/homebrew/bin"))
      assert.ok(augmented.includes("/usr/local/bin"))
      assert.ok(augmented.includes("/usr/bin"))
    }

    const res = resolvePiCommand(
      { PATH: "", HOME: fakeHome },
      { homeDir: fakeHome, userHomeDir: realHome, includeDefaultGuiPath: false, extraPathDirs: [guiBin] },
    )
    assert.equal(res.available, true)
    if (res.available) {
      assert.equal(res.command.executable, await realpath(exePath))
      assert.deepEqual(res.command.args, [])
      assert.equal(res.command.env?.PI_CODING_AGENT_DIR, join(realHome, ".pi", "agent"))
      assert.ok(res.command.env?.PATH?.includes(guiBin))
    }

    // 未传入 userHomeDir 时默认回落真实 os.userInfo().homedir，而不是 env.HOME
    const expectedRealUserHome = (() => {
      try { return userInfo().homedir || homedir() } catch { return homedir() }
    })()
    const resDefaultUser = resolvePiCommand(
      { PATH: "", HOME: fakeHome },
      { homeDir: fakeHome, includeDefaultGuiPath: false, extraPathDirs: [guiBin] },
    )
    assert.equal(resDefaultUser.available, true)
    if (resDefaultUser.available) {
      assert.equal(resDefaultUser.command.env?.PI_CODING_AGENT_DIR, join(expectedRealUserHome, ".pi", "agent"))
    }

    // 显式设置 PI_CODING_AGENT_DIR 时原样保留
    const customConfigDir = join(root, "custom-pi-agent")
    const resExplicit = resolvePiCommand(
      { PATH: guiBin, PI_CODING_AGENT_DIR: customConfigDir },
      { includeDefaultGuiPath: false },
    )
    assert.equal(resExplicit.available, true)
    if (resExplicit.available) {
      assert.equal(resExplicit.command.env?.PI_CODING_AGENT_DIR, customConfigDir)
    }

    // 未安装时明确不可用
    const missing = resolvePiCommand({ PATH: join(root, "empty") }, { includeDefaultGuiPath: false })
    assert.equal(missing.available, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
