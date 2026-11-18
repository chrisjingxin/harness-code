/** 更新已有 systemd 中继：先核对配置与数据库脚本，再备份程序、重启并检查健康状态。 */
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const args = process.argv.slice(2)
const targets = args.filter(value => !value.startsWith("--"))
const flags = args.filter(value => value.startsWith("--"))
if (flags.includes("--help")) {
  console.log("用法：npm run server:deploy -- <用户@服务器> [--check] [--allow-memory-loss]")
  process.exit(0)
}
if (targets.length !== 1 || flags.some(flag => !["--check", "--allow-memory-loss"].includes(flag)) ||
    !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(targets[0])) {
  console.error("用法：npm run server:deploy -- <用户@服务器> [--check] [--allow-memory-loss]")
  process.exit(1)
}
const target = targets[0]
const token = randomBytes(16).toString("hex")
const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]
const stage = `/opt/collaboration-server/bin/.upload-${token}.jar`

/** 远端只输出部署所需的非敏感配置和摘要；数据库凭据留在服务器。 */
const inspectScript = String.raw`
import hashlib, json, os, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit
class CheckError(Exception):
    pass
try:
    import yaml
    root = Path('/opt/collaboration-server')
    config = root / 'config/application.yml'
    jar = root / 'bin/collaboration-server.jar'
    schema = root / 'sql/schema.sql'
    unit = Path('/etc/systemd/system/collaboration-server.service')
    pid = int(subprocess.check_output(['systemctl', 'show', '--property=MainPID', '--value', 'collaboration-server.service'], text=True).strip())
    if pid <= 0 or subprocess.run(['systemctl', 'is-active', '--quiet', 'collaboration-server.service']).returncode:
        raise CheckError('现有 collaboration-server 服务未运行')
    command = [part.decode() for part in Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0') if part]
    expected_config = '--spring.config.additional-location=file:/opt/collaboration-server/config/application.yml'
    if str(jar) not in command or expected_config not in command:
        raise CheckError('现有服务的程序或配置路径与预期不同')
    names = {entry.split(b'=', 1)[0].decode('ascii', 'replace') for entry in Path('/proc', str(pid), 'environ').read_bytes().split(b'\0') if b'=' in entry}
    overrides = {'WORKBENCH_MIDDLEWARE_MODE', 'WORKBENCH_ORIGIN', 'SERVER_PORT', 'SPRING_APPLICATION_JSON', 'SPRING_PROFILES_ACTIVE', 'SPRING_CONFIG_LOCATION', 'SPRING_CONFIG_ADDITIONAL_LOCATION', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'}
    if names & overrides or any(name.startswith(('SPRING_CONFIG_', 'SPRING_PROFILES_')) for name in names) or any(part.startswith(('--workbench.middleware.mode', '--workbench.origin', '--server.port', '--spring.profiles.', '-Dworkbench.', '-Dserver.port', '-Dspring.')) or (part.startswith('--spring.config.') and part != expected_config) for part in command):
        raise CheckError('服务使用额外配置覆盖，无法安全判断当前消息存储模式')
    data = yaml.safe_load(config.read_text()) or {}
    if (data.get('spring') or {}).get('profiles') or (data.get('spring') or {}).get('config'):
        raise CheckError('服务使用额外的 Spring 配置，无法安全判断当前消息存储模式')
    workbench = data.get('workbench') or {}
    mode = (workbench.get('middleware') or {}).get('mode', 'cluster')
    origin = workbench.get('origin')
    port = (data.get('server') or {}).get('port', 18084)
    parsed = urlsplit(origin or '')
    if mode not in ('standalone', 'cluster') or parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not isinstance(port, int) or not 1 <= port <= 65535:
        raise CheckError('服务配置中的消息模式、地址或端口无效')
    if any(not path.is_file() or path.is_symlink() for path in (config, jar, schema, unit)):
        raise CheckError('现有程序、配置、数据库脚本或 systemd 文件缺失')
    if subprocess.run(['sudo', '-n', 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        raise CheckError('当前 SSH 用户不能无交互重启 systemd 服务')
    def digest(path):
        with path.open('rb') as stream:
            return hashlib.file_digest(stream, 'sha256').hexdigest()
    print(json.dumps({'pid': pid, 'mode': mode, 'origin': origin, 'port': port,
        'configHash': digest(config), 'jarHash': digest(jar), 'schemaHash': digest(schema), 'unitHash': digest(unit)}))
except CheckError as error:
    print('无法检查现有服务：' + str(error), file=sys.stderr)
    sys.exit(1)
except Exception:
    print('无法读取现有服务；请检查 systemd、Python、PyYAML 和配置文件权限。', file=sys.stderr)
    sys.exit(1)
`

function ssh(script, capture = false) {
  const result = spawnSync("ssh", [...sshOptions, "--", target, "python3", "-"], {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
  })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? "远端命令失败。")
  return result.stdout?.trim()
}

async function hashFile(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

try {
  const info = JSON.parse(ssh(inspectScript, true))
  const schemaHash = await hashFile(join(root, "services/collaboration-server/src/main/resources/db/schema.sql"))
  console.log(`远端服务：${info.origin}；消息模式：${info.mode}`)
  if (info.schemaHash !== schemaHash) throw new Error("远端数据库脚本与本地不同；请先核对数据库结构和备份，本工具不会自动改表。")
  console.log("数据库脚本与本地一致；现有配置和数据库不会被本工具覆盖。")
  if (flags.includes("--check")) {
    if (info.mode === "standalone") console.log("当前使用内存消息；部署重启会清空共享会话正文。")
    process.exit(0)
  }
  if (info.mode === "standalone" && !flags.includes("--allow-memory-loss")) {
    throw new Error("当前使用内存消息，重启会清空共享会话正文。请先解决持久化；只有明确接受丢失演示数据时才使用 --allow-memory-loss。")
  }

  const npm = process.env.npm_execpath
  if (!npm) throw new Error("请通过 npm run server:deploy 启动。")
  const build = spawnSync(process.execPath, [npm, "run", "server:build"], { cwd: root, stdio: "inherit" })
  if (build.error || build.status !== 0) throw new Error(build.error?.message ?? "Java 构建失败。")
  const version = (await readFile(join(root, "VERSION"), "utf8")).trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("VERSION 无效。")
  const jar = join(root, `services/collaboration-server/target/release/collaboration-server-${version}.jar`)
  const jarHash = await hashFile(jar)
  if (jarHash === info.jarHash) { console.log("远端已有相同程序，无需重启。"); process.exit(0) }

  const payload = Buffer.from(JSON.stringify({ ...info, jarHashNew: jarHash, stage, token })).toString("base64")
  const activateScript = String.raw`
import base64, datetime, hashlib, json, os, shutil, signal, subprocess, sys, time, urllib.request
from pathlib import Path
from urllib.parse import urlsplit
data = json.loads(base64.b64decode('${payload}'))
root = Path('/opt/collaboration-server')
jar, config, schema = root / 'bin/collaboration-server.jar', root / 'config/application.yml', root / 'sql/schema.sql'
unit = Path('/etc/systemd/system/collaboration-server.service')
stage = Path(data['stage'])
lock = root / '.deploy-lock'
installed = False
backup = None
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
def interrupt(signum, frame):
    raise KeyboardInterrupt('部署被中断')
for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, interrupt)
try:
    lock.mkdir(mode=0o700)
except FileExistsError:
    print('另一次部署正在进行，或部署锁需要人工检查。', file=sys.stderr)
    sys.exit(1)
try:
    pid = int(subprocess.check_output(['systemctl', 'show', '--property=MainPID', '--value', 'collaboration-server.service'], text=True).strip())
    if pid != data['pid'] or digest(config) != data['configHash'] or digest(unit) != data['unitHash'] or digest(schema) != data['schemaHash'] or digest(jar) != data['jarHash']:
        raise RuntimeError('构建期间远端服务或配置已变化，请重新检查后部署')
    if stage.is_symlink() or not stage.is_file() or digest(stage) != data['jarHashNew']:
        raise RuntimeError('上传的程序不完整或校验失败')
    backup = root / 'backups' / ('deploy-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + data['token'][:8])
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(jar, backup / 'collaboration-server.jar')
    shutil.copymode(jar, stage)
    os.replace(stage, jar)
    installed = True
    subprocess.run(['sudo', '-n', 'systemctl', 'restart', 'collaboration-server.service'], check=True, timeout=40)
    host = urlsplit(data['origin']).netloc
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(60):
        try:
            request = urllib.request.Request('http://127.0.0.1:' + str(data['port']) + '/health', headers={'Host': host})
            with opener.open(request, timeout=2) as response:
                body = json.load(response)
            if body.get('body', {}).get('status') == 'UP' and not subprocess.run(['systemctl', 'is-active', '--quiet', 'collaboration-server.service']).returncode:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('新服务未通过健康检查')
    print('部署成功；旧程序备份：' + str(backup))
    installed = False
except BaseException as error:
    if installed and backup:
        try:
            restore = root / 'bin' / ('.restore-' + data['token'] + '.jar')
            shutil.copy2(backup / 'collaboration-server.jar', restore)
            os.replace(restore, jar)
            subprocess.run(['sudo', '-n', 'systemctl', 'restart', 'collaboration-server.service'], check=True, timeout=40)
            print('新版本启动失败，已恢复旧程序；备份：' + str(backup), file=sys.stderr)
        except BaseException as rollback_error:
            print('自动恢复失败，请检查备份 ' + str(backup) + '：' + str(rollback_error), file=sys.stderr)
    print('部署失败：' + str(error), file=sys.stderr)
    sys.exit(1)
finally:
    try:
        stage.unlink(missing_ok=True)
    finally:
        lock.rmdir()
`
  try {
    const upload = spawnSync("scp", [...sshOptions, jar, `${target}:${stage}`], { cwd: root, stdio: "inherit" })
    if (upload.error || upload.status !== 0) throw new Error(upload.error?.message ?? "上传程序失败。")
    ssh(activateScript)
  } finally {
    // 仅清理本次随机命名的上传文件；不触碰现有程序或备份。
    try { ssh(`from pathlib import Path\nPath('${stage}').unlink(missing_ok=True)\n`) } catch {}
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "部署失败。")
  process.exitCode = 1
}
