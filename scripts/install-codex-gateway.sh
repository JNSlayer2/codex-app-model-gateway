#!/usr/bin/env bash
# install-codex-gateway.sh — drop-in installer that makes Codex App multi-model
# switching work on THIS machine, regardless of where node/claude/grok/codex live.
#
# Why machines fail without this: the launchd gateway runs with a minimal PATH,
# so bare `claude`/`grok` spawns hit ENOENT (e.g. grok lives in ~/.grok/bin).
# This installer DETECTS absolute CLI paths on this machine and bakes them into
# the plist as CLAUDE_COMMAND / GROK_COMMAND + an augmented PATH, then wires the
# single-provider Codex config, loads the gateway, and verifies.
#
# Idempotent. Rollback-safe (backs up config + plist). Never patches the signed
# Codex App bundle. Run with --preflight first to see what this machine needs.
#
# Usage:
#   bash install-codex-gateway.sh --preflight   # read-only: detect + report, no changes
#   bash install-codex-gateway.sh               # install / repair
#
# Override anything via env: MODEL_GATEWAY_DIR, MODEL_GATEWAY_PORT, CODEX_HOME_TARGET
set -uo pipefail

MODE="${1:-install}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${MODEL_GATEWAY_PORT:-4177}"
HOST="${MODEL_GATEWAY_HOST:-127.0.0.1}"
# Heavy workloads (ultrawork + 1M-context Claude) need long turns and SSE keepalive so
# Codex App does not trip its stream-idle timeout. Overridable per machine.
CLAUDE_TIMEOUT_MS="${CLAUDE_TIMEOUT_MS:-600000}"
GROK_TIMEOUT_MS="${GROK_TIMEOUT_MS:-300000}"
# M3 long-context first-byte can exceed 120s; 480s avoids misclassifying slow
# (but healthy) bulk fan-out responses as network errors.
MINIMAX_TIMEOUT_MS="${MINIMAX_TIMEOUT_MS:-480000}"
GATEWAY_HEARTBEAT_MS="${GATEWAY_HEARTBEAT_MS:-15000}"
URL="http://$HOST:$PORT"
USER_NAME="$(id -un)"
LABEL="${GATEWAY_LABEL:-com.${USER_NAME}.codex-model-gateway}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# Gateway runtime dir (contains server.js + package.json). Default: ../ from this script,
# else a sibling "model-gateway". Override with MODEL_GATEWAY_DIR.
GW_DIR="${MODEL_GATEWAY_DIR:-}"
TS="$(date +%Y%m%d-%H%M%S)"

c_ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
c_no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; }
c_warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }
die(){ printf '\033[31mABORT:\033[0m %s\n' "$1" >&2; exit 1; }

echo "== Codex App model_gateway installer ($MODE) =="
echo "   user=$USER_NAME  label=$LABEL  url=$URL"
echo

# ---- locate gateway runtime ----
if [ -z "$GW_DIR" ]; then
  for cand in "$SCRIPT_DIR/../runtime" "$SCRIPT_DIR/../model-gateway" "$HOME/model-gateway" "$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"; do
    [ -f "$cand/server.js" ] && { GW_DIR="$cand"; break; }
  done
fi
[ -n "$GW_DIR" ] && [ -f "$GW_DIR/server.js" ] || die "找不到 gateway runtime（server.js）。設 MODEL_GATEWAY_DIR=<dir>。"
GW_DIR="$(cd "$GW_DIR" && pwd)"
c_ok "gateway runtime: $GW_DIR"

# ---- detect this machine's CLIs (absolute paths) ----
NODE_BIN="$(command -v node || true)"
CODEX_BIN="$(command -v codex || true)"
CLAUDE_BIN="$(command -v claude || true)"
GROK_BIN="$(command -v grok || true)"
[ -n "$NODE_BIN" ] || die "node 不在 PATH。先裝 node。"
[ -n "$CODEX_BIN" ] || c_warn "codex CLI 不在 PATH（GUI app 仍可用，但驗收/遷移需要 codex CLI）。"
c_ok "node:   ${NODE_BIN}"
[ -n "$CODEX_BIN" ]  && c_ok "codex:  ${CODEX_BIN}"
[ -n "$CLAUDE_BIN" ] && c_ok "claude: ${CLAUDE_BIN}" || c_warn "claude CLI 未偵測到 → opus/sonnet/haiku 路由不可用，要先裝 Claude Code。"
[ -n "$GROK_BIN" ]   && c_ok "grok:   ${GROK_BIN}"   || c_warn "grok CLI 未偵測到 → grok-build 路由不可用（選用，可略）。"

# ---- detect auth state (the usual manual blockers) ----
NEED_CODEX_LOGIN=0; NEED_GROK_LOGIN=0
CODEX_HOME_EFF="${CODEX_HOME:-$HOME/.codex}"
[ -f "$CODEX_HOME_EFF/auth.json" ] && c_ok "codex auth present ($CODEX_HOME_EFF/auth.json)" || { c_warn "codex 未登入（$CODEX_HOME_EFF/auth.json 不存在）→ 需 'codex login'"; NEED_CODEX_LOGIN=1; }
MINIMAX_SECRET_FILE="${MINIMAX_API_KEY_FILE:-$HOME/.codex/secrets/minimax.env}"
if [ -f "$MINIMAX_SECRET_FILE" ]; then
  c_ok "minimax key file present ($MINIMAX_SECRET_FILE)"
else
  c_warn "minimax key file 未偵測到 → minimax-m3 會出現在 catalog，但實際呼叫會 fail-closed。可建立 $MINIMAX_SECRET_FILE"
fi
if [ -n "$GROK_BIN" ]; then
  if "$GROK_BIN" models >/dev/null 2>&1 && ! "$GROK_BIN" models 2>&1 | grep -qi 'not authenticated'; then
    c_ok "grok authenticated"
  else
    c_warn "grok 未登入 → 需 'grok login --oauth'"; NEED_GROK_LOGIN=1
  fi
fi

# ---- CODEX_HOME safety: external/noowners volume is the documented crash hazard ----
case "$CODEX_HOME_EFF" in
  /Volumes/*) c_warn "CODEX_HOME 指向外接卷（${CODEX_HOME_EFF}）：codex 在 noowners 外接卷可能 crash／撤存取。建議 export CODEX_HOME=\$HOME/.codex（SSD）。" ;;
esac

# ---- build the launchd PATH from detected tool dirs (so spawns never ENOENT) ----
# bash 3.2 safe (macOS default bash has no associative arrays)
PLIST_PATH=""
_addpath(){ case ":$PLIST_PATH:" in *":$1:"*) ;; *) PLIST_PATH="${PLIST_PATH:+$PLIST_PATH:}$1" ;; esac; }
for b in "$NODE_BIN" "$CLAUDE_BIN" "$GROK_BIN" "$CODEX_BIN"; do
  [ -n "$b" ] && _addpath "$(dirname "$b")"
done
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do _addpath "$d"; done
c_ok "launchd PATH: $PLIST_PATH"

if [ "$MODE" = "--preflight" ] || [ "$MODE" = "preflight" ]; then
  echo
  echo "== PREFLIGHT 摘要（未做任何更動）=="
  [ "$NEED_CODEX_LOGIN" = 1 ] && echo "  → 手動步驟：codex login"
  [ "$NEED_GROK_LOGIN" = 1 ]  && echo "  → 手動步驟：grok login --oauth"
  [ ! -f "$MINIMAX_SECRET_FILE" ] && echo "  → 選用：建立 ~/.codex/secrets/minimax.env 供 minimax-m3 使用"
  [ "$NEED_CODEX_LOGIN" = 0 ] && [ "$NEED_GROK_LOGIN" = 0 ] && echo "  → 無待辦手動步驟，可直接跑安裝（不帶 --preflight）。"
  exit 0
fi

# ===================== INSTALL =====================
# 1) sanity: gateway tests
( cd "$GW_DIR" && "$NODE_BIN" --check server.js ) || die "server.js 語法檢查失敗"
if [ -f "$GW_DIR/package.json" ]; then ( cd "$GW_DIR" && npm test >/tmp/install-gw-test.log 2>&1 ) && c_ok "npm test 綠" || c_warn "npm test 未過（見 /tmp/install-gw-test.log）— 仍續裝，但建議先修。"; fi

# 2) write launchd plist (backup if exists)
[ -f "$PLIST" ] && cp "$PLIST" "$PLIST.bak-$TS" && c_ok "備份舊 plist → $PLIST.bak-$TS"
mkdir -p "$HOME/Library/LaunchAgents"
{
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${GW_DIR}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE_BIN}</string><string>${GW_DIR}/server.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${PLIST_PATH}</string>
    <key>MODEL_GATEWAY_HOST</key><string>${HOST}</string>
    <key>MODEL_GATEWAY_PORT</key><string>${PORT}</string>
    <key>CLAUDE_TIMEOUT_MS</key><string>${CLAUDE_TIMEOUT_MS}</string>
    <key>GROK_TIMEOUT_MS</key><string>${GROK_TIMEOUT_MS}</string>
    <key>MINIMAX_TIMEOUT_MS</key><string>${MINIMAX_TIMEOUT_MS}</string>
    <key>GATEWAY_HEARTBEAT_MS</key><string>${GATEWAY_HEARTBEAT_MS}</string>
    <key>MINIMAX_BASE_URL</key><string>https://api.minimax.io/v1</string>
    <key>MINIMAX_API_KEY_FILE</key><string>${MINIMAX_SECRET_FILE}</string>
    <key>GATEWAY_API_MODEL_ALLOWLIST</key><string>minimax-near-unlimited-api</string>
PLIST_EOF
  [ -n "$CLAUDE_BIN" ] && printf '    <key>CLAUDE_COMMAND</key><string>%s</string>\n' "$CLAUDE_BIN"
  [ -n "$GROK_BIN" ]   && printf '    <key>GROK_COMMAND</key><string>%s</string>\n' "$GROK_BIN"
  cat <<PLIST_EOF
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${GW_DIR}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${GW_DIR}/logs/launchd.err.log</string>
</dict></plist>
PLIST_EOF
} > "$PLIST"
mkdir -p "$GW_DIR/logs"
plutil -lint "$PLIST" >/dev/null || die "產生的 plist 不合法"
c_ok "寫入 plist（CLAUDE_COMMAND/GROK_COMMAND 用絕對路徑，PATH-independent）"

# 3) ensure single-provider Codex config (backup first). Target ~/.codex (GUI default).
CFG_HOME="${CODEX_HOME_TARGET:-$HOME/.codex}"; CFG="$CFG_HOME/config.toml"
mkdir -p "$CFG_HOME"; [ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$TS" && c_ok "備份 config → $CFG.bak-$TS"
touch "$CFG"
grep -q '^model[[:space:]]*=' "$CFG" || printf 'model = "gpt-5.5"\n' >> "$CFG"
if grep -q '^model_provider[[:space:]]*=' "$CFG"; then
  sed -i '' 's/^model_provider[[:space:]]*=.*/model_provider = "model_gateway"/' "$CFG"
else
  printf 'model_provider = "model_gateway"\n' >> "$CFG"
fi

set_top_key() {
  key="$1"; value="$2"
  if grep -q "^[[:space:]]*$key[[:space:]]*=" "$CFG"; then
    sed -i '' "s|^[[:space:]]*$key[[:space:]]*=.*|$key = $value|" "$CFG"
  else
    printf '%s = %s\n' "$key" "$value" >> "$CFG"
  fi
}
set_top_key model_reasoning_effort '"low"'
set_top_key service_tier '"fast"'
set_top_key model_auto_compact_token_limit '200000'
set_top_key model_auto_compact_token_limit_scope '"total"'

if ! grep -q '^\[model_providers.model_gateway\]' "$CFG"; then
  cat >> "$CFG" <<PROV_EOF

[model_providers.model_gateway]
name = "Model Gateway"
base_url = "${URL}/v1"
wire_api = "responses"
requires_openai_auth = true
PROV_EOF
fi
c_ok "config 已設 model_provider = model_gateway（${CFG}）"

# 4) keep the Codex sidebar coherent after changing the top-level provider.
# Existing unarchived threads can remain pinned to model_provider=openai; when
# the app is now running as model_gateway, those threads may disappear from the
# project sidebar even though they were not deleted. Do a backed-up one-time
# merge unless explicitly disabled.
if [ "${SKIP_THREAD_PROVIDER_MIGRATION:-0}" = "1" ]; then
  c_warn "略過 thread provider migration；若專案列表顯示沒有聊天，請跑 scripts/migrate-sidebar-threads-to-gateway.sh"
elif [ -f "$SCRIPT_DIR/migrate-sidebar-threads-to-gateway.sh" ]; then
  if CODEX_HOME="$CFG_HOME" bash "$SCRIPT_DIR/migrate-sidebar-threads-to-gateway.sh" >/tmp/install-thread-provider-migration.log 2>&1; then
    c_ok "thread provider 已合併到 model_gateway（sidebar-safe；見 /tmp/install-thread-provider-migration.log）"
  else
    c_warn "thread provider migration 未完成（見 /tmp/install-thread-provider-migration.log）；若 sidebar 少 thread，先修這項"
  fi
else
  c_warn "找不到 migrate-sidebar-threads-to-gateway.sh；無法自動避免 sidebar provider split"
fi

# 5) (re)load the gateway
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "launchctl bootstrap 失敗"
c_ok "gateway 已載入 launchd"

# 6) verify
ok=1
curl --retry 15 --retry-delay 1 --retry-connrefused -fsS --max-time 8 "$URL/healthz" >/tmp/install-health.json 2>/dev/null \
  && [ "$(jq -r .ok /tmp/install-health.json 2>/dev/null)" = "true" ] && c_ok "healthz ok" || { c_no "healthz 失敗"; ok=0; }
curl -fsS --max-time 6 "$URL/v1/models" 2>/dev/null | jq -e '.models[]?|select(.slug=="gpt-5.5")' >/dev/null 2>&1 \
  && c_ok "catalog 列出 gpt-5.5" || { c_no "catalog 異常"; ok=0; }
if [ -n "$CODEX_BIN" ]; then
  "$CODEX_BIN" debug models -c model_provider='"model_gateway"' 2>/dev/null | jq -r '.models[]?.slug' | grep -q '^gpt-5\.5$' \
    && c_ok "codex 看得到 gateway catalog" || c_warn "codex debug models 看不到 → 檢查 config parse"
fi

echo
echo "== 後續手動步驟（本機尚缺的）=="
[ "$NEED_CODEX_LOGIN" = 1 ] && echo "  • codex login            （GPT passthrough 需要）"
[ "$NEED_GROK_LOGIN" = 1 ]  && echo "  • grok login --oauth     （grok-build 需要）"
[ "$NEED_CODEX_LOGIN" = 0 ] && [ "$NEED_GROK_LOGIN" = 0 ] && echo "  • 無（auth 都就緒）"
echo "  • 驗收：bash $SCRIPT_DIR/post-update-check.sh        （快速、不花 quota）"
echo "  • 完整：bash $SCRIPT_DIR/post-update-check.sh --full （同 thread 切換，花 Claude quota）"
echo
[ "$ok" = 1 ] && printf '\033[32m== 安裝完成：Codex App 已接單一 provider model_gateway ==\033[0m\n' \
             || printf '\033[31m== 安裝完成但驗收有缺，照上面 ✗ 修，或看 skill 失敗處理 ==\033[0m\n'
