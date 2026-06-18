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
EXPECT_SLUGS=(gpt-5.5 chatgpt-pro-consult opus-4-7 opus-4-8 sonnet-4-6 haiku-4-6 fable-5 grok-build minimax-m3)
NODE_BIN="$(command -v node || true)"

full=0; [ "${1:-}" = "--full" ] && full=1
fails=0
pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; }
warn(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails+1)); }
note(){ printf '       \342\206\263 %s\n' "$1"; }
json_expr(){ "$NODE_BIN" -e 'const fs=require("fs"); const file=process.argv[1]; const expr=process.argv[2]; const j=JSON.parse(fs.readFileSync(file,"utf8")); const result=Function("j","return ("+expr+")")(j); if (result === undefined || result === null) process.exit(1); if (typeof result === "boolean") process.exit(result ? 0 : 1); console.log(result);' "$1" "$2"; }
json_has_model(){ "$NODE_BIN" -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const slug=process.argv[2]; process.exit((j.models||[]).some(m=>m.slug===slug)?0:1);' "$1" "$2"; }
curl_retry(){ curl --retry 12 --retry-delay 1 --retry-connrefused -fsS --max-time 6 "$@"; }
curl_stream_retry(){ curl --retry 8 --retry-delay 1 --retry-connrefused -sS --max-time 12 -N "$@"; }

echo "== Codex App model_gateway post-update / repair check =="
echo "   gateway: $GATEWAY_URL   label: $LABEL   full=$full"
echo

if [ -z "$NODE_BIN" ]; then
  warn "node 不在 PATH；gateway runtime 與 JSON 驗收都需要 node"
  note "安裝 Node.js 後重跑 install-codex-gateway.sh"
fi

echo "[1] config provider（更新最可能重設這個）"
for H in "$HOME/.codex" "${CODEX_HOME:-}"; do
  [ -z "$H" ] && continue; cfg="$H/config.toml"; [ -f "$cfg" ] || continue
  if grep -Eq '^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"model_gateway"' "$cfg" 2>/dev/null; then
    pass "model_provider = model_gateway  ($cfg)"
  else
    warn "model_provider 不是 model_gateway  ($cfg)"
    note "還原：cp <backup>/config.toml \"$cfg\"（備份在 \$HOME/.codex/*.bak-* 或 backups/）；或重跑 install-codex-gateway.sh"
  fi
  if grep -Eq '^[[:space:]]*model_reasoning_effort[[:space:]]*=[[:space:]]*"low"' "$cfg" 2>/dev/null; then
    pass "model_reasoning_effort = low  ($cfg)"
  else
    warn "model_reasoning_effort 不是 low/fast  ($cfg)"
    note "修復：設 model_reasoning_effort = \"low\"；深度推理改在單條 thread/plan mode 調高"
  fi
  if grep -Eq '^[[:space:]]*service_tier[[:space:]]*=[[:space:]]*"fast"' "$cfg" 2>/dev/null; then
    pass "service_tier = fast  ($cfg)"
  else
    warn "service_tier 不是 fast  ($cfg)"
    note "修復：設 service_tier = \"fast\"；切 gateway 後 UI fast 鍵不會由 catalog 補出"
  fi
  if grep -Eq '^[[:space:]]*model_auto_compact_token_limit_scope[[:space:]]*=[[:space:]]*"total"' "$cfg" 2>/dev/null; then
    pass "auto-compact scope = total  ($cfg)"
  else
    warn "auto-compact scope 不是 total  ($cfg)"
    note "修復：設 model_auto_compact_token_limit_scope = \"total\"，避免長 thread 撞窗前不壓縮"
  fi
done

echo "[2] gateway healthz（launchd 進程，App 更新殺不掉它）"
if curl_retry "$GATEWAY_URL/healthz" >/tmp/puc_health.json 2>/dev/null; then
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_health.json 'j.ok===true' >/dev/null 2>&1; then
    provider="$(json_expr /tmp/puc_health.json 'j.provider || "unknown"' 2>/dev/null || echo unknown)"
    pass "healthz ok ($provider)"
  else
    warn "healthz ok!=true"
  fi
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_health.json '!!(j.capabilities && j.capabilities.minimax && j.capabilities.minimax.spend_allowed)' >/dev/null 2>&1; then
    pass "MiniMax API route allowlisted"
  else
    note "MiniMax API route 未 allowlist；minimax-m3 會 fail-closed，設 GATEWAY_API_MODEL_ALLOWLIST=minimax-near-unlimited-api 後重啟 gateway"
  fi
else
  warn "gateway 連不上 $GATEWAY_URL"
  note "重啟：launchctl kickstart -k gui/\$(id -u)/$LABEL"
fi

echo "[3] model catalog"
if curl_retry "$GATEWAY_URL/v1/models" >/tmp/puc_models.json 2>/dev/null; then
  miss=""; for s in "${EXPECT_SLUGS[@]}"; do [ -n "$NODE_BIN" ] && json_has_model /tmp/puc_models.json "$s" >/dev/null 2>&1 || miss="$miss $s"; done
  [ -z "$miss" ] && pass "expected slugs 齊全" || warn "catalog 缺:$miss"
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_models.json '(j.models||[]).some(m=>m.slug==="chatgpt-pro-consult" && m.capabilities && m.capabilities.role==="codex_native_consultant" && m.capabilities.upstream_model==="gpt-5.5")' >/dev/null 2>&1; then
    pass "chatgpt-pro-consult 顧問 route 標記正確"
  else
    warn "chatgpt-pro-consult catalog metadata 異常"
  fi
  not_low="$([ -n "$NODE_BIN" ] && json_expr /tmp/puc_models.json '(j.models||[]).filter(m=>(m.default_reasoning_level||"")!=="low").map(m=>m.slug).join(" ")' 2>/dev/null || echo "")"
  [ -z "$not_low" ] && pass "all catalog default_reasoning_level = low" || warn "catalog 有非 low default_reasoning_level:$not_low"
else warn "/v1/models 連不上"; fi

echo "[4] codex debug models（config 端到端接通）"
if command -v codex >/dev/null 2>&1; then
  codex debug models -c model_provider='"model_gateway"' >/tmp/puc_codex_models.json 2>/dev/null \
    && [ -n "$NODE_BIN" ] && json_has_model /tmp/puc_codex_models.json chatgpt-pro-consult >/dev/null 2>&1 \
    && pass "codex 看得到 gateway catalog" || { warn "codex 看不到 gateway catalog"; note "config parse error 或被更新重設；檢查 [model_providers.model_gateway]"; }
else note "codex CLI 不在 PATH，略過"; fi

echo "[5] GPT passthrough route（401 無授權 = 正確 fail-closed）"
b=$(curl_stream_retry "$GATEWAY_URL/v1/responses" -H 'content-type: application/json' \
  -d '{"model":"chatgpt-pro-consult","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"x"}]}],"stream":true}' 2>/dev/null)
if printf '%s' "$b" | grep -q 'requires Codex ChatGPT Authorization'; then pass "GPT route 活著且正確 fail-closed"
elif printf '%s' "$b" | grep -q 'response.completed'; then pass "GPT route 回了完整回應"
else warn "GPT route 回應異常"; note "'not implemented'→gateway 退版；404→config provider 沒接上"; fi

echo "[5b] auth/session 健康度（refresh-token 輪換競爭預警）"
main_auth="$SAFE_CODEX_HOME/auth.json"
if [ -f "$main_auth" ]; then
  # 多份 auth.json 不同步 = 輪換競爭溫床：一個 consumer 刷新就作廢其餘,
  # 後端對壞 session 退化成 free 限額（症狀: 401 invalidated / 假撞限額）。
  main_id="$(stat -f '%d:%i' "$main_auth" 2>/dev/null || stat -c '%d:%i' "$main_auth" 2>/dev/null)"
  divergent=""
  for sib in "$HOME/.codex/auth.json" "$HOME/.codex-sub/auth.json" "${CODEX_HOME:-}/auth.json"; do
    [ -f "$sib" ] || continue
    [ "$sib" = "$main_auth" ] && continue
    sib_real="$(readlink -f "$sib" 2>/dev/null || echo "$sib")"
    main_real="$(readlink -f "$main_auth" 2>/dev/null || echo "$main_auth")"
    [ "$sib_real" = "$main_real" ] && continue
    sib_id="$(stat -f '%d:%i' "$sib" 2>/dev/null || stat -c '%d:%i' "$sib" 2>/dev/null)"
    if [ -n "$sib_id" ] && [ "$sib_id" != "$main_id" ]; then divergent="$divergent $sib"; fi
  done
  if [ -z "$divergent" ]; then
    pass "auth.json 單一真相源（無分歧副本）"
  else
    warn "發現分歧的 auth.json 副本:$divergent"
    note "修復：備份後把副本改成 symlink 指向 $main_auth；若已出現 401 invalidated → 靜默全部消費者後 codex logout && codex login 再逐一開回"
  fi
else
  note "找不到 $main_auth，略過 auth 健康度"
fi

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
