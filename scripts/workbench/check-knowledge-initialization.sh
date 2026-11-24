#!/usr/bin/env bash
# 仅对本卡新建隔离库模拟旧知识元数据；绝不接受用户现有数据库地址。
set -euo pipefail
: "${JAVA_HOME:?指定JDK21}"
: "${HC241_MYSQL_ROOT:?指定MySQL8目录}"
hc241_dir=${1:?指定本卡隔离证据目录}
[[ $hc241_dir == /private/tmp/hc241-live.* && -f $hc241_dir/api-evidence.json && -f $hc241_dir/keep-running ]]
cd "$(dirname "$0")/../.."
hc241_id=$(node --input-type=module -e 'import fs from "node:fs";console.log(JSON.parse(fs.readFileSync(process.argv[1])).knowledgeId)' "$hc241_dir/api-evidence.json")
[[ $hc241_id =~ ^[0-9a-f-]{36}$ ]]
hc241_sql=("$HC241_MYSQL_ROOT/bin/mysql" --no-defaults --protocol=SOCKET --socket="$hc241_dir/mysql.sock" -uroot --default-character-set=utf8mb4 -N hc241_smoke)
hc241_snapshot="SELECT version_id,version,author_id,SHA2(text,256) FROM wb_knowledge_version WHERE knowledge_id='$hc241_id' ORDER BY version;"
"${hc241_sql[@]}" -e "$hc241_snapshot" > "$hc241_dir/initialization-before.tsv"
"${hc241_sql[@]}" -e "UPDATE wb_knowledge_version SET level='',scope_kind='',content_type='',contributors='[]',proposal_id='',reviewer_id='',reviewed_at=NULL WHERE knowledge_id='$hc241_id' AND version=1;"
for hc241_round in 1 2; do
  "$JAVA_HOME/bin/java" -jar "server/target/collaboration-server-$(tr -d '\r\n' < VERSION).jar" --workbench.command=init-knowledge --workbench.middleware.mode=standalone --spring.config.additional-location="file:$hc241_dir/jdbc.properties" > "$hc241_dir/initialization-$hc241_round.log" 2>&1
  "${hc241_sql[@]}" -e "SELECT version_id,level,scope_kind,content_type,contributors,reviewer_id,reviewed_at FROM wb_knowledge_version WHERE knowledge_id='$hc241_id' ORDER BY version;" > "$hc241_dir/initialization-metadata-$hc241_round.tsv"
done
"${hc241_sql[@]}" -e "$hc241_snapshot" > "$hc241_dir/initialization-after.tsv"
cmp "$hc241_dir/initialization-before.tsv" "$hc241_dir/initialization-after.tsv"
cmp "$hc241_dir/initialization-metadata-1.tsv" "$hc241_dir/initialization-metadata-2.tsv"
[[ $("${hc241_sql[@]}" -e "SELECT COUNT(*) FROM wb_knowledge_version WHERE knowledge_id='$hc241_id' AND version=1 AND level='experience' AND scope_kind='workspace' AND content_type='article' AND reviewer_id='' AND reviewed_at IS NULL;") == 1 ]]
printf 'PASS：显式初始化保留ID/版本/作者/正文；重复不覆盖；历史不伪造复核\n'
