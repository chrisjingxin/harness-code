#!/usr/bin/env bash
# HC-240：只创建临时 MySQL 数据目录与独立 Java 服务，不连接或修改用户已有库。
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
: "${JAVA_HOME:?请指定 JDK21}"
: "${HC240_MYSQL_ROOT:?请指定 MySQL8 安装目录}"
root=$(mktemp -d /private/tmp/hc240-live.XXXXXX)
echo "$root" > /private/tmp/hc240-active-smoke-root
printf 'HC-240 证据目录 %s\n' "$root"
read -r mysql_port java_port < <(node --input-type=module <<'JS'
import { createServer } from 'node:net'
const a=createServer(),b=createServer()
await new Promise(r=>a.listen(0,'127.0.0.1',r)); await new Promise(r=>b.listen(0,'127.0.0.1',r))
console.log(a.address().port,b.address().port);a.close();b.close()
JS
)
db_pid=
java_pid=
cleanup() {
  for pid in "$java_pid" "$db_pid"; do if [[ -n $pid ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; done
  rm -f "$root/jdbc.properties"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$root/mysql"
sql=("$HC240_MYSQL_ROOT/bin/mysql" --no-defaults --protocol=SOCKET --socket="$root/mysql.sock" -uroot --default-character-set=utf8mb4)
"$HC240_MYSQL_ROOT/bin/mysqld" --no-defaults --basedir="$HC240_MYSQL_ROOT" --datadir="$root/mysql" --initialize-insecure >"$root/mysql-init.log" 2>&1
"$HC240_MYSQL_ROOT/bin/mysqld" --no-defaults --basedir="$HC240_MYSQL_ROOT" --datadir="$root/mysql" --bind-address=127.0.0.1 --port="$mysql_port" --mysqlx=OFF --socket="$root/mysql.sock" --pid-file="$root/mysql.pid" >"$root/mysql.log" 2>&1 &
db_pid=$!
for ((i=0;i<100;i++)); do if "${sql[@]}" -e 'SELECT 1' >/dev/null 2>&1; then break; fi; kill -0 "$db_pid"; sleep .2; done
password=$(openssl rand -hex 24)
"${sql[@]}" <<SQL
CREATE DATABASE hc240_smoke CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'hc240_smoke'@'127.0.0.1' IDENTIFIED BY '$password' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON hc240_smoke.* TO 'hc240_smoke'@'127.0.0.1';
SQL
"${sql[@]}" hc240_smoke < server/src/main/resources/db/schema.sql
"${sql[@]}" hc240_smoke < server/src/main/resources/db/demo-data.sql
origin=http://127.0.0.1:$java_port
printf '%s\n' "$origin" > "$root/origin"
cat > "$root/jdbc.properties" <<PROPERTIES
spring.datasource.url=jdbc:mysql://127.0.0.1:$mysql_port/hc240_smoke?sslMode=REQUIRED
spring.datasource.username=hc240_smoke
spring.datasource.password=$password
PROPERTIES
env -i PATH="$PATH" TMPDIR="$root" "$JAVA_HOME/bin/java" -jar "server/target/collaboration-server-$(tr -d '\r\n' < VERSION).jar" --workbench.command=start --workbench.middleware.mode=standalone --spring.config.additional-location="file:$root/jdbc.properties" --server.address=127.0.0.1 --server.port="$java_port" --workbench.origin="$origin" > "$root/java.log" 2>&1 &
java_pid=$!
for ((i=0;i<150;i++)); do if curl --noproxy '*' -fsS --max-time 1 "$origin/health" >/dev/null 2>&1; then break; fi; kill -0 "$java_pid"; sleep .25; done
curl --noproxy '*' -fsS --max-time 1 "$origin/health" >/dev/null
node scripts/workbench/smoke-workspace-roles.mjs "$origin" "$root/api-evidence.json"
"${sql[@]}" hc240_smoke -e 'SELECT user_id,role,status,version FROM wb_workspace_member; SELECT task_id,creator_id,assignee_id,status,version,conversation_id FROM wb_task;' > "$root/state.tsv"
if [[ ${HC240_KEEP_SERVICE:-0} = 1 ]]; then
  touch "$root/keep-running"
  printf '隔离服务已准备：%s（删除证据目录内 keep-running 后关闭）\n' "$origin"
  while [[ -f "$root/keep-running" ]]; do sleep 1; done
fi
