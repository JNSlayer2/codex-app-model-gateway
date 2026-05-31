#!/usr/bin/env bash
# One-time sidebar-safe provider merge.
#
# Why this exists:
# When the top-level Codex provider is changed from "openai" to "model_gateway",
# existing unarchived threads can remain pinned to model_provider="openai".
# Codex App may then hide those threads in the project sidebar while showing only
# model_gateway threads. This script backs up state and rewrites unarchived openai
# threads plus their rollout session metadata to model_gateway.
set -eu

CODEX_HOME_EFF="${CODEX_HOME:-$HOME/.codex}"
DB="${CODEX_STATE_SQLITE:-$CODEX_HOME_EFF/state_5.sqlite}"
TARGET_PROVIDER="${TARGET_PROVIDER:-model_gateway}"
SOURCE_PROVIDER="${SOURCE_PROVIDER:-openai}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$CODEX_HOME_EFF/backups/sidebar-provider-merge-$TS}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }
}

need sqlite3
need node

[ -f "$DB" ] || { echo "missing state database: $DB" >&2; exit 1; }

mkdir -p "$BACKUP_DIR/rollouts"
cp "$DB" "$BACKUP_DIR/state_5.sqlite"

sqlite3 -csv "$DB" \
  "select id, rollout_path from threads where archived=0 and model_provider='$SOURCE_PROVIDER';" \
  > "$BACKUP_DIR/affected_threads.csv"

count="$(wc -l < "$BACKUP_DIR/affected_threads.csv" | tr -d ' ')"
if [ "$count" = "0" ]; then
  echo "ok: no unarchived $SOURCE_PROVIDER threads to migrate"
  echo "backup=$BACKUP_DIR"
  exit 0
fi

while IFS=, read -r _id rollout; do
  rollout=${rollout%$'\r'}
  [ -n "$rollout" ] && [ -f "$rollout" ] && cp "$rollout" "$BACKUP_DIR/rollouts/$(basename "$rollout")"
done < "$BACKUP_DIR/affected_threads.csv"

sqlite3 "$DB" \
  "update threads set model_provider='$TARGET_PROVIDER' where archived=0 and model_provider='$SOURCE_PROVIDER';"

BACKUP_CSV="$BACKUP_DIR/affected_threads.csv" TARGET_PROVIDER="$TARGET_PROVIDER" node <<'NODE'
const fs = require("fs");
const csv = fs.readFileSync(process.env.BACKUP_CSV, "utf8").trim();
if (!csv) process.exit(0);
for (const line of csv.split(/\n/)) {
  const comma = line.indexOf(",");
  if (comma < 0) continue;
  const file = line.slice(comma + 1).replace(/\r$/, "");
  if (!file || !fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, "utf8");
  const nl = raw.indexOf("\n");
  const first = nl === -1 ? raw : raw.slice(0, nl);
  const rest = nl === -1 ? "" : raw.slice(nl);
  let obj;
  try {
    obj = JSON.parse(first);
  } catch {
    continue;
  }
  if (obj.type === "session_meta" && obj.payload) {
    obj.payload.model_provider = process.env.TARGET_PROVIDER;
    fs.writeFileSync(file, JSON.stringify(obj) + rest);
  }
}
NODE

echo "migrated=$count"
echo "backup=$BACKUP_DIR"
sqlite3 "$DB" \
  "select model_provider,count(*) from threads where archived=0 group by model_provider order by count(*) desc;"
