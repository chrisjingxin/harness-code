/** 显式 Java 入口：读取 VERSION → 准备原字节契约/版本资源 → 构建或运行指定命令。
 * 纯桌面 install/build 不调用此文件；工具由开发者在任务目录准备，本脚本不安装系统服务。
 */
import { spawn } from "node:child_process"
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { loadContracts } from "./check-contracts.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const service = join(root, "services/collaboration-server")
const command = process.argv[2]
if (process.argv.length !== 3 || !["build", "migrate", "init-demo", "start", "contracts"].includes(command)) throw new Error("必须选择一个已登记的服务端命令")
const version = (await readFile(join(root, "VERSION"), "utf8")).trim()
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("VERSION 无效")
const jar = join(service, "target", `collaboration-server-${version}.jar`)
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java"

/** 透传停止信号，只管理自己启动的进程；不用 shell 解析用户目录和凭据。 */
function run(executable, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd: root, env: process.env, stdio: "inherit" })
    const stop = () => child.kill("SIGTERM")
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
      if (code === 0) resolveRun()
      else reject(new Error(`服务端命令失败: ${signal ?? code}`))
    })
  })
}
if (command === "build") {
  await loadContracts()
  await mkdir(join(service, "target/generated-resources"), { recursive: true })
  await writeFile(join(service, "target/generated-resources/build.properties"), `productVersion=${version}\n`)
  const maven = process.env.MAVEN_EXECUTABLE ?? (process.platform === "win32" ? "mvn.cmd" : "mvn")
  await run(maven, ["-B", "-f", join(service, "pom.xml"), `-Drevision=${version}`, "-DskipTests", "package"])
  const sqlDir = join(service, "src/main/resources/db/migration")
  const { readdir } = await import("node:fs/promises")
  const release = join(service, "target/release")
  await mkdir(join(release, "sql"), { recursive: true })
  await copyFile(jar, join(release, `collaboration-server-${version}.jar`))
  const sums = []
  for (const file of (await readdir(sqlDir)).filter(n => /^V\d+__[a-z0-9_]+\.sql$/.test(n)).sort()) {
    const bytes = await readFile(join(sqlDir, file))
    await writeFile(join(release, "sql", file), bytes)
    sums.push(`${createHash("sha256").update(bytes).digest("hex")}  sql/${file}`)
  }
  sums.push(`${createHash("sha256").update(await readFile(jar)).digest("hex")}  collaboration-server-${version}.jar`)
  await writeFile(join(release, "SHA256SUMS.txt"), sums.join("\n") + "\n")
} else {
  await run(java, ["-jar", jar, `--workbench.command=${command}`])
}
