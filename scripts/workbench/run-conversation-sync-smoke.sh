#!/usr/bin/env bash
# HC-211 独立 MySQL 和 Java 冒烟，工具由调用方提供，运行资料留在新临时目录。
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
: "${JAVA_HOME:?请指定 JDK 21}"
: "${HC211_SMOKE_MYSQL_ROOT:?请指定本机 MySQL 8.4 安装目录}"
root=$(mktemp -d /tmp/hc211-sync.XXXXXX)
echo "HC-211 证据目录 $root"
read -r mysql_port java_port < <(node --input-type=module <<'JS'
import { createServer } from "node:net"
const a = createServer()
const b = createServer()
await new Promise(resolve => a.listen(0, "127.0.0.1", resolve))
await new Promise(resolve => b.listen(0, "127.0.0.1", resolve))
console.log(a.address().port, b.address().port)
a.close()
b.close()
JS
)
db_pid=
java_pid=
cleanup() {
  for pid in "$java_pid" "$db_pid"; do
    if [[ -n $pid ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$root/jdbc.properties"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

service=server
jar="$service/target/collaboration-server-$(tr -d '\r\n' < VERSION).jar"
test -f "$jar"
mkdir "$root/mysql" "$root/access"
mysql_root=$HC211_SMOKE_MYSQL_ROOT
sql=("$mysql_root/bin/mysql" --no-defaults --protocol=SOCKET --socket="$root/mysql.sock" -uroot --default-character-set=utf8mb4)
"$mysql_root/bin/mysqld" --no-defaults --basedir="$mysql_root" --datadir="$root/mysql" --initialize-insecure >"$root/mysql-init.log" 2>&1
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
CREATE DATABASE hc211_smoke CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'hc211_smoke'@'127.0.0.1' IDENTIFIED BY '$password' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON hc211_smoke.* TO 'hc211_smoke'@'127.0.0.1';
SQL
"${sql[@]}" hc211_smoke < "$service/src/main/resources/db/schema.sql"
"${sql[@]}" hc211_smoke < "$service/src/main/resources/db/demo-data.sql"
"${sql[@]}" --batch hc211_smoke -e 'SHOW TABLES' >"$root/tables.tsv"
table_count=$("${sql[@]}" --skip-column-names hc211_smoke -e 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()')
test "$table_count" = 19
origin=http://127.0.0.1:$java_port
echo "$origin" >"$root/origin"
cat >"$root/jdbc.properties" <<PROPERTIES
spring.datasource.url=jdbc:mysql://127.0.0.1:$mysql_port/hc211_smoke?sslMode=REQUIRED
spring.datasource.username=hc211_smoke
spring.datasource.password=$password
PROPERTIES
env -i PATH="$PATH" TMPDIR="$root" \
  "$JAVA_HOME/bin/java" -jar "$jar" --workbench.command=start --workbench.middleware.mode=standalone \
  --spring.config.additional-location="file:$root/jdbc.properties" \
  --server.address=127.0.0.1 --server.port="$java_port" --workbench.origin="$origin" \
  --server.tomcat.accesslog.enabled=true --server.tomcat.accesslog.directory="$root/access" \
  --server.tomcat.accesslog.prefix=http --server.tomcat.accesslog.suffix=.log \
  --server.tomcat.accesslog.rotate=false --server.tomcat.accesslog.buffered=false \
  '--server.tomcat.accesslog.pattern=%m %U%q %s' >"$root/java.log" 2>&1 &
java_pid=$!
for ((attempt=0; attempt<120; attempt++)); do
  if curl --noproxy '*' -fsS --max-time 1 "$origin/health" >/dev/null 2>&1; then break; fi
  kill -0 "$java_pid"
  sleep 0.25
done
curl --noproxy '*' -fsS --max-time 1 "$origin/health" >/dev/null
node scripts/workbench/smoke-conversation-sync.mjs "$origin" "$root/evidence.json"
"${sql[@]}" --batch hc211_smoke -e \
  'SELECT conversation_id, owner_user_id, synced_sequence, brief_text FROM wb_conversation' >"$root/conversation.tsv"
shasum -a 256 "$jar" "$service/src/main/resources/db/schema.sql" "$service/src/main/resources/db/demo-data.sql" >"$root/artifact-hashes.txt"
