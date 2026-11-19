/** 用临时目录模拟 SSH 和 systemd，检查部署保护、回滚与桌面地址传递。 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const tmp = await mkdtemp(join(tmpdir(), "workbench-remote-smoke-"))
const repo = join(tmp, "repo")
const server = join(tmp, "server")
const bin = join(tmp, "bin")
const unit = join(tmp, "collaboration-server.service")
const infoFile = join(tmp, "info.json")
const buildLog = join(tmp, "build.log")
const restartLog = join(tmp, "restart.log")
const uploadLog = join(tmp, "upload.log")
const fakeNpm = join(tmp, "npm.cjs")
const hash = value => createHash("sha256").update(value).digest("hex")
const exists = path => readFile(path).then(() => true, () => false)
let health

try {
  await mkdir(join(repo, "scripts/workbench"), { recursive: true })
  await mkdir(join(repo, "server/src/main/resources/db"), { recursive: true })
  await mkdir(join(repo, "server/target/release"), { recursive: true })
  await mkdir(bin)
  for (const file of ["deploy-remote.mjs", "remote-desktop.mjs"]) {
    await copyFile(join(root, "scripts/workbench", file), join(repo, "scripts/workbench", file))
  }
  await writeFile(join(repo, "VERSION"), "0.2.0\n")
  await writeFile(join(repo, "server/src/main/resources/db/schema.sql"), "schema")
  await writeFile(join(repo, "server/target/release/collaboration-server-0.2.0.jar"), "new jar")
  await writeFile(fakeNpm, "require('node:fs').appendFileSync(process.env.TEST_BUILD_LOG,'run\\n'); console.log('origin='+process.env.WORKBENCH_SERVICE_ORIGIN)\n")
  await writeFile(join(bin, "ssh"), `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
let input = fs.readFileSync(0, 'utf8');
if (input.includes('import yaml')) { process.stdout.write(fs.readFileSync(process.env.TEST_INFO)); process.exit(0); }
if (input.includes('data = json.loads(base64.b64decode')) {
  input = input.replaceAll('/opt/collaboration-server', process.env.TEST_SERVER).replaceAll('/etc/systemd/system/collaboration-server.service', process.env.TEST_UNIT);
  input = input.replace("stage = Path(data['stage'])", "stage = Path(data['stage'].replace('/opt/collaboration-server', os.environ['TEST_SERVER']))");
  const child = cp.spawnSync('python3', ['-'], { input, encoding: 'utf8', env: process.env });
  process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); process.exit(child.status ?? 1);
}
const name = input.match(/\\.upload-[0-9a-f]{32}\\.jar/);
if (!name) process.exit(2);
fs.rmSync(require('node:path').join(process.env.TEST_SERVER, 'bin', name[0]), { force: true });
`, { mode: 0o755 })
  await writeFile(join(bin, "scp"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), name = path.basename(args.at(-1));
if (!/^\\.upload-[0-9a-f]{32}\\.jar$/.test(name)) process.exit(2);
fs.copyFileSync(args.at(-2), path.join(process.env.TEST_SERVER, 'bin', name));
fs.appendFileSync(process.env.TEST_UPLOAD_LOG, 'upload\\n');
if (process.env.TEST_MUTATE_CONFIG) fs.appendFileSync(path.join(process.env.TEST_SERVER, 'config/application.yml'), 'changed');
`, { mode: 0o755 })
  await writeFile(join(bin, "systemctl"), "#!/usr/bin/env node\nif (process.argv.includes('show')) console.log('12345')\n", { mode: 0o755 })
  await writeFile(join(bin, "sudo"), `#!/usr/bin/env node
const fs = require('node:fs'), path = process.env.TEST_RESTART_LOG;
fs.appendFileSync(path, 'restart\\n');
if (process.env.TEST_FAIL_FIRST && fs.readFileSync(path, 'utf8').trim().split('\\n').length === 1) process.exit(1);
`, { mode: 0o755 })

  health = spawn(process.execPath, ["-e", `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({body:{status:'UP'}}))}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})`], { stdio: ["ignore", "pipe", "inherit"] })
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("测试健康服务启动超时")), 5000)
    health.once("error", reject)
    health.stdout.once("data", data => { clearTimeout(timer); resolvePort(Number(data.toString().trim())) })
  })
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, npm_execpath: fakeNpm,
    TEST_INFO: infoFile, TEST_SERVER: server, TEST_UNIT: unit, TEST_BUILD_LOG: buildLog,
    TEST_RESTART_LOG: restartLog, TEST_UPLOAD_LOG: uploadLog }
  const desktop = join(repo, "scripts/workbench/remote-desktop.mjs")
  const deploy = join(repo, "scripts/workbench/deploy-remote.mjs")
  const run = (file, args, extra = {}) => spawnSync(process.execPath, [file, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 })

  let result = run(desktop, ["http://127.0.0.1:18084/"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /origin=http:\/\/127\.0\.0\.1:18084/)
  await rm(buildLog, { force: true })
  result = run(desktop, ["http://example.invalid/path"])
  assert.equal(result.status, 1)
  assert.equal(await exists(buildLog), false)
  result = run(desktop, ["http://user:password@example.invalid"])
  assert.equal(result.status, 1)
  assert.equal(await exists(buildLog), false)

  async function prepare(mode) {
    await rm(server, { recursive: true, force: true })
    await mkdir(join(server, "bin"), { recursive: true })
    await mkdir(join(server, "config"))
    await mkdir(join(server, "sql"))
    await writeFile(join(server, "bin/collaboration-server.jar"), "old jar")
    await writeFile(join(server, "config/application.yml"), "config")
    await writeFile(join(server, "sql/schema.sql"), "schema")
    await writeFile(unit, "unit")
    await rm(buildLog, { force: true })
    await rm(restartLog, { force: true })
    await rm(uploadLog, { force: true })
    await writeFile(infoFile, JSON.stringify({ pid: 12345, mode, origin: `http://127.0.0.1:${port}`, port,
      configHash: hash("config"), jarHash: hash("old jar"), schemaHash: hash("schema"), unitHash: hash("unit") }))
  }

  await prepare("standalone")
  result = run(deploy, ["ubuntu@test-server", "--check"])
  assert.equal(result.status, 0, result.stderr)
  result = run(deploy, ["ubuntu@test-server"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /重启会清空共享会话正文/)
  assert.equal(await exists(buildLog), false)
  assert.equal(await exists(uploadLog), false)
  result = run(deploy, ["ubuntu@test-server;false"])
  assert.equal(result.status, 1)
  assert.equal(await exists(buildLog), false)
  assert.equal(await exists(uploadLog), false)

  result = run(deploy, ["ubuntu@test-server", "--allow-memory-loss"], { TEST_FAIL_FIRST: "1" })
  assert.equal(result.status, 1)
  assert.equal(await readFile(join(server, "bin/collaboration-server.jar"), "utf8"), "old jar")
  assert.equal((await readFile(restartLog, "utf8")).trim().split("\n").length, 2)
  assert.equal((await readdir(join(server, "bin"))).length, 1)

  await prepare("cluster")
  const mismatched = JSON.parse(await readFile(infoFile, "utf8"))
  mismatched.schemaHash = hash("different schema")
  await writeFile(infoFile, JSON.stringify(mismatched))
  result = run(deploy, ["ubuntu@test-server"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /数据库脚本与本地不同/)
  assert.equal(await exists(buildLog), false)
  assert.equal(await exists(uploadLog), false)

  await prepare("cluster")
  result = run(deploy, ["ubuntu@test-server"], { TEST_MUTATE_CONFIG: "1" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /远端服务或配置已变化/)
  assert.equal(await readFile(join(server, "bin/collaboration-server.jar"), "utf8"), "old jar")
  assert.equal(await exists(restartLog), false)

  await prepare("cluster")
  result = run(deploy, ["ubuntu@test-server"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(server, "bin/collaboration-server.jar"), "utf8"), "new jar")
  const backups = await readdir(join(server, "backups"))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(server, "backups", backups[0], "collaboration-server.jar"), "utf8"), "old jar")
  assert.equal(await exists(join(server, ".deploy-lock")), false)
  console.log("远端命令冒烟通过：地址传递、内存保护、回滚、并发配置变更和健康检查。")
} finally {
  health?.kill("SIGTERM")
  await rm(tmp, { recursive: true, force: true })
}
