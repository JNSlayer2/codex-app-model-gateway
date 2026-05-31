#!/usr/bin/env bash
# post-update-check.sh — run AFTER updating (or to repair) Codex App, to confirm
# the model_gateway multi-model switching still works.
#
# READ-ONLY by default; spends NO Claude/Grok quota (only a 401 probe).
# Pass --full to also run the real same-thread acceptance (costs Claude quota).
# Remedies follow the codex-app-model-gateway skill (失敗處理 / 回滾).
# Portable: derives label/paths; override via env.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOSTP="${MODEL_GATEWAY_HOST:-127.0.0.1}"; PORTP="${MODEL_GATEWAY_PORT:-4177}"
GATEWAY_URL="${GATEWAY_URL:-http://$HOSTP:$PORTP}"
LABEL="${GATEWAY_LABEL:-com.$(id -un).codex-model-gateway}"
SAFE_CODEX_HOME="${SAFE_CODEX_HOME:-$HOME/.codex}"
LIVE_VERIFY="${LIVE_VERIFY:-$SCRIPT_DIR/live-verify-codex-gateway.sh}"
# gateway runtime dir (for --full live-verify)
GW_DIR="${MODEL_GATEWAY_DIR:-}"
if [ -z "$GW_DIR" ]; then
  for c in "$SCRIPT_DIR/../runtime" "$SCRIPT_DIR/../model-gateway" "$HOME/model-gateway" "$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"; do
    [ -f "$c/server.js" ] && { GW_DIR="$(cd "$c" && pwd)"; break; }
  done
fi
EXPECT_SLUGS=(gpt-5.5 opus-4-7 opus-4-8 sonnet-4-6 haiku-4-6 grok-build)

full=0; [ "${1:-}" = "--full" ] && full=1
fails=0
pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; }
warn(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails+1)); }
note(){ printf '       \342\206\263 %s\n' "$1"; }

echo "== Codex App model_gateway post-update / repair check =="
echo "   gateway: $GATEWAY_URL   label: $LABEL   full=$full"
echo

echo "[1] config provider（更新最可能重設這個）"
for H in "$HOME/.codex" "${CODEX_HOME:-}"; do
  [ -z "$H" ] && continue; cfg="$H/config.toml"; [ -f "$cfg" ] || continue
  if rg -q '^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"model_gateway"' "$cfg" 2>/dev/null; then
    pass "model_provider = model_gateway  ($cfg)"
  else
    warn "model_provider 不是 model_gateway  ($cfg)"
    note "還原：cp <backup>/config.toml \"$cfg\"（備份在 \$HOME/.codex/*.bak-* 或 backups/）；或重跑 install-codex-gateway.sh"
  fi
done

echo "[2] gateway healthz（launchd 進程，App 更新殺不掉它）"
if curl -fsS --max-time 6 "$GATEWAY_URL/healthz" >/tmp/puc_health.json 2>/dev/null; then
  [ "$(jq -r .ok /tmp/puc_health.json 2>/dev/null)" = "true" ] && pass "healthz ok ($(jq -r .provider /tmp/puc_health.json))" || warn "healthz ok!=true"
else
  warn "gateway 連不上 $GATEWAY_URL"
  note "重啟：launchctl kickstart -k gui/\$(id -u)/$LABEL"
fi

echo "[3] model catalog"
if curl -fsS --max-time 6 "$GATEWAY_URL/v1/models" >/tmp/puc_models.json 2>/dev/null; then
  miss=""; for s in "${EXPECT_SLUGS[@]}"; do jq -e --arg s "$s" '.models[]?|select(.slug==$s)' /tmp/puc_models.json >/dev/null 2>&1 || miss="$miss $s"; done
  [ -z "$miss" ] && pass "expected slugs 齊全" || warn "catalog 缺:$miss"
else warn "/v1/models 連不上"; fi

echo "[4] codex debug models（config 端到端接通）"
if command -v codex >/dev/null 2>&1; then
  codex debug models -c model_provider='"model_gateway"' 2>/dev/null | jq -r '.models[]?.slug' | rg -q '^gpt-5\.5$' \
    && pass "codex 看得到 gateway catalog" || { warn "codex 看不到 gateway catalog"; note "config parse error 或被更新重設；檢查 [model_providers.model_gateway]"; }
else note "codex CLI 不在 PATH，略過"; fi

echo "[5] GPT passthrough route（401 無授權 = 正確 fail-closed）"
b=$(curl -sS --max-time 12 -N "$GATEWAY_URL/v1/responses" -H 'content-type: application/json' \
  -d '{"model":"gpt-5.5","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"x"}]}],"stream":true}' 2>/dev/null)
if printf '%s' "$b" | rg -q 'requires Codex ChatGPT Authorization'; then pass "GPT route 活著且正確 fail-closed"
elif printf '%s' "$b" | rg -q 'response.completed'; then pass "GPT route 回了完整回應"
else warn "GPT route 回應異常"; note "'not implemented'→gateway 退版；404→config provider 沒接上"; fi

echo "[6] sidebar thread provider coherence（避免專案列表顯示沒有聊天）"
state_db="$SAFE_CODEX_HOME/state_5.sqlite"
if [ -f "$state_db" ] && command -v sqlite3 >/dev/null 2>&1; then
  openai_threads="$(sqlite3 "$state_db" "select count(*) from threads where archived=0 and model_provider='openai';" 2>/dev/null || echo 0)"
  gateway_threads="$(sqlite3 "$state_db" "select count(*) from threads where archived=0 and model_provider='model_gateway';" 2>/dev/null || echo 0)"
  if [ "${openai_threads:-0}" = "0" ]; then
    pass "unarchived threads all use model_gateway ($gateway_threads visible)"
  else
    warn "$openai_threads unarchived openai thread(s) may be hidden while app runs model_gateway"
    note "修復：bash $SCRIPT_DIR/migrate-sidebar-threads-to-gateway.sh（會備份 SQLite + rollout 首行）"
  fi
else
  note "state_5.sqlite 不可用，略過 sidebar provider coherence"
fi

if [ "$full" = 1 ]; then
  echo "[7] same-thread 驗收（--full，花 Claude quota）"
  if [ -f "$LIVE_VERIFY" ] && [ -n "$GW_DIR" ]; then
    if MODEL_GATEWAY_DIR="$GW_DIR" CODEX_HOME="$SAFE_CODEX_HOME" bash "$LIVE_VERIFY" >/tmp/puc_full.log 2>&1; then
      pass "live-verify 全 PASS（含同 thread 上下文接續）"
    else warn "live-verify 失敗 → tail -30 /tmp/puc_full.log，對照 skill 失敗處理"; fi
  else warn "找不到 live-verify 或 gateway dir（設 LIVE_VERIFY / MODEL_GATEWAY_DIR）"; fi
else
  echo "[7] same-thread 驗收：SKIPPED（加 --full 才實際切換、花 quota）"
fi

echo
[ "$fails" -eq 0 ] && { printf '\033[32m== ALL PASS — 模型切換能力完好 ==\033[0m\n'; exit 0; } \
                   || { printf '\033[31m== %s 項失敗 — 照上面 ↳ 修，或重跑 install-codex-gateway.sh ==\033[0m\n' "$fails"; exit 1; }
