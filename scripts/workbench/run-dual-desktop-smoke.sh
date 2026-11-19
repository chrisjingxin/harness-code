#!/usr/bin/env bash
# 在独立目录运行真实 MySQL、Java 和两个正式 Electron。输出仅保留本轮日志和断言证据。
set -euo pipefail
umask 077

cd "$(dirname "$0")/../.."
: "${JAVA_HOME:?请指定 JDK 21}"
: "${HC218_SMOKE_MYSQL_ROOT:?请指定本机 MySQL 8.4 安装目录}"
: "${HC218_SMOKE_PYTHON:?请指定已安装 Harness Agent 依赖的 Python}"
mysql_port=${HC218_SMOKE_MYSQL_PORT:-33184}
java_port=${HC218_SMOKE_JAVA_PORT:-18184}
for port in "$mysql_port" "$java_port"; do
  if [[ ! $port =~ ^[1-9][0-9]{3,4}$ ]] || ((port < 1024 || port > 65535)); then
    echo "无效联调端口 $port" >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null; then
    echo "联调端口已被占用 $port" >&2
    exit 1
  fi
done
[[ $mysql_port != "$java_port" ]]
root=$(mktemp -d /tmp/hc218-live.XXXXXX)
echo "联调证据目录 $root"
mkdir "$root/mysql" "$root/access"
db_pid=
java_pid=
cleanup() {
  for pid in "$java_pid" "$db_pid"; do
    if [[ -n $pid ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$root/mysql" "$root/A" "$root/B" "$root/jdbc.properties"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mysql_root=$HC218_SMOKE_MYSQL_ROOT
sql=("$mysql_root/bin/mysql" --no-defaults --protocol=SOCKET --socket="$root/mysql.sock" -uroot --default-character-set=utf8mb4)
service=server
jar="$service/target/collaboration-server-$(tr -d '\r\n' < VERSION).jar"
test -f "$jar"
"$mysql_root/bin/mysqld" --no-defaults --basedir="$mysql_root" --datadir="$root/mysql" \
  --initialize-insecure >"$root/mysql-init.log" 2>&1
"$mysql_root/bin/mysqld" --no-defaults --basedir="$mysql_root" --datadir="$root/mysql" \
  --bind-address=127.0.0.1 --port="$mysql_port" --mysqlx=OFF --socket="$root/mysql.sock" \
  --pid-file="$root/mysql.pid" >"$root/mysql.log" 2>&1 &
db_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
  if "${sql[@]}" -e 'SELECT 1' >/dev/null 2>&1; then break; fi
  kill -0 "$db_pid"
  sleep 0.2
done
password=$(openssl rand -hex 24)
"${sql[@]}" <<SQL
CREATE DATABASE hc218_smoke CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'hc218_smoke'@'127.0.0.1' IDENTIFIED BY '$password' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON hc218_smoke.* TO 'hc218_smoke'@'127.0.0.1';
SQL
"${sql[@]}" hc218_smoke < "$service/src/main/resources/db/schema.sql"
"${sql[@]}" hc218_smoke < "$service/src/main/resources/db/demo-data.sql"

origin=http://127.0.0.1:$java_port
cat >"$root/jdbc.properties" <<PROPERTIES
spring.datasource.url=jdbc:mysql://127.0.0.1:$mysql_port/hc218_smoke?sslMode=REQUIRED
spring.datasource.username=hc218_smoke
spring.datasource.password=$password
PROPERTIES
env -i PATH="$PATH" TMPDIR="$root" \
  "$JAVA_HOME/bin/java" -jar "$jar" --workbench.command=start --workbench.middleware.mode=standalone \
  --spring.config.additional-location="file:$root/jdbc.properties" \
  --server.address=127.0.0.1 --server.port="$java_port" --workbench.origin="$origin" \
  --server.tomcat.accesslog.enabled=true --server.tomcat.accesslog.directory="$root/access" \
  --server.tomcat.accesslog.prefix=http --server.tomcat.accesslog.suffix=.log \
  --server.tomcat.accesslog.rotate=false --server.tomcat.accesslog.buffered=false \
  '--server.tomcat.accesslog.pattern=%m %U%q %s %{X-HC218-Smoke}i' >"$root/java.log" 2>&1 &
java_pid=$!
for ((attempt=0; attempt<120; attempt++)); do
  if curl --noproxy '*' -fsS --max-time 1 "$origin/health" >/dev/null 2>&1; then break; fi
  kill -0 "$java_pid"
  sleep 0.25
done
curl --noproxy '*' -fsS --max-time 1 "$origin/health" >/dev/null
node scripts/workbench/smoke-dual-desktop.mjs "$origin" "$root"
"${sql[@]}" --batch hc218_smoke -e \
  'SELECT conversation_id, device_id, synced_sequence, brief_text FROM wb_conversation' >"$root/conversation.tsv"
