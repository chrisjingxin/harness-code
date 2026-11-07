/** 真实身份冒烟的隔离宿主：编译当前生产main → 复用已有实例 → 驱动客户端 → 恢复夹具/停止进程。
 * 只显式调用，不安装工具、不初始化数据库、不打印或复制 runtime 中的凭据。
 */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { connect } from "node:net"
import { open, readFile, writeFile, access } from "node:fs/promises"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import assert from "node:assert/strict"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const required = name => { const value = process.env[name]; assert(value, `缺少 ${name}`); return value }
const root = resolve(required("HC194_SMOKE_ROOT"))
const mysql = resolve(required("HC194_SMOKE_MYSQL_ROOT"))
const java = join(resolve(required("JAVA_HOME")), "bin", process.platform === "win32" ? "java.exe" : "java")
const runtime = join(root, "runtime")
const data = join(root, "mysql-data")
const mysqlPort = Number(process.env.HC194_SMOKE_MYSQL_PORT ?? 33074)
const javaPort = Number(process.env.HC194_SMOKE_JAVA_PORT ?? 18084)
assert(Number.isInteger(mysqlPort) && Number.isInteger(javaPort) && mysqlPort > 1024 && mysqlPort < 65536 && javaPort > 1024 && javaPort < 65536 && mysqlPort !== javaPort, "端口必须是不同的本机高位端口")
const origin = `http://127.0.0.1:${javaPort}`
await access(join(data, "auto.cnf")) // 只允许已有实例；缺失即停止，不调用 initialize。
const secrets = JSON.parse(await readFile(join(runtime, "db-secrets.json"), "utf8"))
const admin = join(runtime, "admin.cnf")
const version = (await readFile(join(repository, "VERSION"), "utf8")).trim()
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), "VERSION无效")
const jar = join(repository, "services/collaboration-server/target", `collaboration-server-${version}.jar`)
const results = []
let database, server, client, enabled, memberTime, snapshot
let completed = false

async function listening(port) {
  return new Promise(done => {
    const socket = connect({ host: "127.0.0.1", port })
    const finish = value => { socket.destroy(); done(value) }
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(false))
  })
}
async function privateProcess(executable, args, name, env = process.env) {
  const file = await open(join(runtime, name), "a", 0o600)
  const process = spawn(executable, args, { cwd: repository, env, stdio: ["ignore", file.fd, file.fd] })
  await file.close()
  process.on("error", () => {})
  return process
}
async function exit(process, timeout = 20000) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("本轮进程停止超时")), timeout)
    process.once("exit", () => { clearTimeout(timer); done() })
  })
}
async function ready(process, port) {
  for (let n = 0; n < 200; n++) {
    if (process.exitCode !== null || process.signalCode !== null) throw new Error("本轮服务启动失败，诊断仅留私有runtime")
    if (await listening(port)) return
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error("本轮服务就绪超时")
}
async function sql(statement) {
  return new Promise((done, reject) => {
    const process = spawn(join(mysql, "bin/mysql"), [`--defaults-file=${admin}`, "--protocol=SOCKET", `--socket=${join(runtime, "mysql.sock")}`, "--default-character-set=utf8mb4", "--batch", "--skip-column-names", "--raw", "hc194_demo"], { stdio: ["pipe", "pipe", "ignore"] })
    let output = ""
    const timer = setTimeout(() => { process.kill("SIGTERM"); reject(new Error("本轮SQL超时")) }, 15000)
    process.stdout.setEncoding("utf8"); process.stdout.on("data", part => { output += part })
    process.once("error", () => { clearTimeout(timer); reject(new Error("无法调用本轮MySQL客户端")) })
    process.once("exit", code => { clearTimeout(timer); code === 0 ? done(output.trim()) : reject(new Error("本轮SQL失败")) })
    process.stdin.end(statement)
  })
}
async function startDatabase() {
  assert(!await listening(mysqlPort), "不能接管已占用的数据库端口")
  database = await privateProcess(join(mysql, "bin/mysqld"), ["--no-defaults", `--basedir=${mysql}`, `--datadir=${data}`, "--bind-address=127.0.0.1", `--port=${mysqlPort}`, "--mysqlx=OFF", `--socket=${join(runtime, "mysql.sock")}`, `--pid-file=${join(runtime, "mysql.pid")}`, `--log-error=${join(runtime, "mysql.err")}`], "identity-mysql.log")
  await ready(database, mysqlPort)
  await sql("SELECT 1;")
}
async function stopDatabase() {
  if (!database || database.exitCode !== null || database.signalCode !== null) return
  const stop = await privateProcess(join(mysql, "bin/mysqladmin"), [`--defaults-file=${admin}`, "--protocol=SOCKET", `--socket=${join(runtime, "mysql.sock")}`, "shutdown"], "identity-shutdown.log")
  await exit(stop); assert.equal(stop.exitCode, 0, "本轮mysqladmin停止失败"); await exit(database); database = undefined
}
async function startServer() {
  assert(!await listening(javaPort), "不能接管已占用的Java端口")
  const configuration = { spring: { datasource: { url: `jdbc:mysql://127.0.0.1:${mysqlPort}/hc194_demo`, username: "hc194_runtime", password: secrets.hc194_runtime,
    hikari: { "data-source-properties": { sslMode: "VERIFY_CA", trustCertificateKeyStoreUrl: pathToFileURL(join(runtime, "mysql-ca.p12")).href, trustCertificateKeyStoreType: "PKCS12", trustCertificateKeyStorePassword: secrets.trust, fallbackToSystemTrustStore: "false", connectTimeout: "3000", socketTimeout: "3000" } } } }, server: { address: "127.0.0.1", port: javaPort }, workbench: { origin } }
  server = await privateProcess(java, ["-jar", jar, "--workbench.command=start"], "identity-server.log", { ...process.env, SPRING_APPLICATION_JSON: JSON.stringify(configuration) })
  await ready(server, javaPort)
}
async function stopServer() { if (server && server.exitCode === null) { server.kill("SIGTERM"); await exit(server) } server = undefined }
const snapshotSql = "SELECT id,username,display_name,enabled,created_at_ms FROM wb_user ORDER BY username; SELECT id,slug,name,created_at_ms FROM wb_workspace ORDER BY slug; SELECT workspace_id,user_id,created_at_ms FROM wb_workspace_member ORDER BY workspace_id,user_id;"
const restoreMember = () => sql(`INSERT INTO wb_workspace_member (workspace_id,user_id,created_at_ms) SELECT w.id,u.id,${memberTime} FROM wb_workspace w JOIN wb_user u ON u.username='user03' WHERE w.slug='demo' AND NOT EXISTS (SELECT 1 FROM wb_workspace_member m WHERE m.workspace_id=w.id AND m.user_id=u.id);`)

try {
  const compiler = await privateProcess(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", join(repository, "apps/desktop/tsconfig.json"), "--noEmit", "false", "--outDir", join(repository, "apps/desktop/dist/lifecycle")], "identity-typecheck.log")
  await exit(compiler); assert.equal(compiler.exitCode, 0, "生产身份源码编译失败，诊断仅留私有runtime")
  await startDatabase(); await startServer()
  snapshot = await sql(snapshotSql)
  enabled = await sql("SELECT enabled FROM wb_user WHERE username='user03';"); assert(/^[01]$/.test(enabled), "原用户夹具无效")
  memberTime = await sql("SELECT m.created_at_ms FROM wb_workspace_member m JOIN wb_user u ON u.id=m.user_id JOIN wb_workspace w ON w.id=m.workspace_id WHERE u.username='user03' AND w.slug='demo';"); assert(/^\d+$/.test(memberTime), "原成员夹具无效")
  for (const script of ["scripts/workbench/smoke-identity.mjs", "scripts/workbench/smoke-identity-lifecycle.mjs"]) {
    const clientLog = await open(join(runtime, "identity-client.log"), "a", 0o600)
    client = spawn(process.execPath, ["--no-warnings", "--experimental-loader", "./scripts/typescript_loader.mjs", script], { cwd: repository, env: { ...process.env, HC194_SMOKE_ORIGIN: origin }, stdio: ["pipe", "pipe", clientLog.fd] })
    await clientLog.close()
    for await (const line of createInterface({ input: client.stdout })) {
      const item = JSON.parse(line)
      switch (item.control) {
        case "disable-user03": await sql("UPDATE wb_user SET enabled=0 WHERE username='user03';"); break
        case "restore-user03": await sql(`UPDATE wb_user SET enabled=${enabled} WHERE username='user03';`); break
        case "remove-member03": await sql("DELETE m FROM wb_workspace_member m JOIN wb_user u ON u.id=m.user_id JOIN wb_workspace w ON w.id=m.workspace_id WHERE u.username='user03' AND w.slug='demo';"); break
        case "restore-member03": await restoreMember(); break
        case "stop-db": await stopDatabase(); break
        case "start-db": await startDatabase(); break
        case "stop-java": await stopServer(); break
        case "start-java": await startServer(); break
        case undefined:
          results.push(item); console.log(JSON.stringify(item))
          // 最终结果之后不再有控制指令；关闭输入，让客户端的读取循环结束并退出。
          if (item.result === "passed") client.stdin.end()
          continue
        default: throw new Error("冒烟发出了未登记控制命令")
      }
      client.stdin.write('{"ok":true}\n')
    }
    await exit(client); assert.equal(client.exitCode, 0, "客户端冒烟失败")
    assert.equal(results.at(-1)?.result, "passed", "冒烟未完成")
  }
  assert((await sql(snapshotSql)) === snapshot, "隔离业务数据未原样恢复")
  results.push({ check: "database-snapshot-restored", ok: true })
  completed = true
} finally {
  if (client && client.exitCode === null) { client.kill("SIGTERM"); await exit(client) }
  try {
    if (enabled !== undefined) {
      if (!database) await startDatabase()
      await sql(`UPDATE wb_user SET enabled=${enabled} WHERE username='user03';`)
      if (memberTime !== undefined) await restoreMember()
    }
  } finally {
    try { await stopServer() } finally { await stopDatabase() }
    await writeFile(join(root, "evidence/identity-stage3-smoke.json"), JSON.stringify({ completed, results, processesStopped: !await listening(mysqlPort) && !await listening(javaPort) }, null, 2) + "\n", { mode: 0o600 })
  }
}
