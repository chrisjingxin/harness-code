/** 生成可发布的 @za38/cli 副本：关闭 private、只带 dist、去掉已打进 bundle 的 protocol。 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export type PublishableCliPackage = {
  stagingDir: string
  packageJson: PublishableCliManifest
}

export type PublishableCliManifest = {
  name: string
  version: string
  private: false
  type: "module"
  bin: { harness: string; za38: string }
  files: string[]
  dependencies: Record<string, string>
}

type CliPackageJson = {
  name: string
  version: string
  type?: string
  bin?: Record<string, string>
  dependencies?: Record<string, string>
}

const BUNDLED_DEPENDENCIES = new Set(["@za38/protocol"])

/** 把源码 package.json 收成安装器可发布的 manifest，不修改仓库内文件。 */
export function publishableCliManifest(source: CliPackageJson): PublishableCliManifest {
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(source.dependencies ?? {})) {
    if (BUNDLED_DEPENDENCIES.has(name)) continue
    if (version.startsWith("workspace:")) {
      throw new Error(`发布物不能保留 workspace 依赖：${name}`)
    }
    dependencies[name] = version
  }
  return {
    name: source.name,
    version: source.version,
    private: false,
    type: "module",
    bin: {
      harness: "./dist/index.js",
      za38: "./dist/index.js",
    },
    files: ["dist"],
    dependencies,
  }
}

/** 在目标目录写入可发布副本（package.json + dist），不打包 node_modules 或 tests。 */
export async function stagePublishableCli(cliRoot: string, stagingDir: string): Promise<PublishableCliPackage> {
  const source = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8")) as CliPackageJson
  const packageJson = publishableCliManifest(source)
  const distSource = join(cliRoot, "dist")
  const distDest = join(stagingDir, "dist")
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(distDest, { recursive: true })
  await cp(distSource, distDest, { recursive: true })
  await writeFile(join(stagingDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
  return { stagingDir, packageJson }
}

/** 对已构建的 CLI dist 打 tarball，返回绝对路径。 */
export async function packPublishableCli(cliRoot: string, outDir: string): Promise<string> {
  const stagingDir = join(outDir, "staging")
  const { packageJson } = await stagePublishableCli(cliRoot, stagingDir)
  await mkdir(outDir, { recursive: true })
  const filename = tarballName(packageJson)
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--filename", filename, "--quiet"], {
    cwd: stagingDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (packed.exitCode !== 0) {
    throw new Error(`bun pm pack 失败：${packed.stderr.toString() || packed.stdout.toString()}`)
  }
  return resolve(stagingDir, filename)
}

function tarballName(packageJson: PublishableCliManifest): string {
  return `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
}

if (import.meta.main) {
  const cliRoot = resolve(import.meta.dir, "..")
  const outDir = resolve(cliRoot, ".publish")
  const tarball = await packPublishableCli(cliRoot, outDir)
  process.stdout.write(`${tarball}\n`)
}
