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
EXPECT_SLUGS=(gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna gpt-5.5 gpt-5.4 gpt-5.4-mini opus-4-7 opus-4-8 sonnet-5 haiku-4-5 fable-5 grok-build minimax-m3)
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
  configured_effort="$(sed -nE 's/^[[:space:]]*model_reasoning_effort[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$cfg" | head -1)"
  if printf '%s\n' "$configured_effort" | grep -Eq '^(low|medium|high|xhigh)$'; then
    pass "model_reasoning_effort = ${configured_effort}，屬跨 provider 共通檔位  ($cfg)"
  else
    warn "model_reasoning_effort 不是跨 provider 共通檔位  ($cfg)"
    note "修復：設為 low / medium / high / xhigh；各外部 CLI 由 gateway 映射到原生推理參數"
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
  live_source_sha="$(json_expr /tmp/puc_health.json 'j.runtime_source && j.runtime_source.sha256' 2>/dev/null || true)"
  current_source_sha=""
  if [ -n "$GW_DIR" ] && [ -f "$GW_DIR/server.js" ]; then
    current_source_sha="$(shasum -a 256 "$GW_DIR/server.js" 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$live_source_sha" ]; then
    warn "healthz 缺少 runtime_source.sha256；目前 listener 不能證明載入中的 source revision"
    note "先部署含 runtime source attestation 的 gateway，再由人工 gate 重啟；不可把 listener 綠燈當成 candidate 已生效"
  elif [ -z "$current_source_sha" ]; then
    warn "無法計算目前 gateway source hash：$GW_DIR/server.js"
  elif [ "$live_source_sha" = "$current_source_sha" ]; then
    pass "gateway runtime source revision 與磁碟 source 一致 (${live_source_sha:0:12})"
  else
    warn "gateway runtime/source revision 漂移（live ${live_source_sha:0:12} != disk ${current_source_sha:0:12}）"
    note "禁止用目前 listener 驗收新修正；人工 gate 後重啟 gateway，再重跑本檢查"
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

echo "[2b] runner isolation（Grok 不可繼承 Claude/Codex bridge 權限規則）"
EXPECTED_GROK_COMMAND="${GROK_ISOLATED_BIN:-$HOME/.codex/bin/grok-isolated}"
active_grok_command="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk -F'=> ' '/GROK_COMMAND =>/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' || true)"
if [ -n "$active_grok_command" ] && [ "$active_grok_command" = "$EXPECTED_GROK_COMMAND" ]; then
  pass "launchd active GROK_COMMAND 使用 isolated launcher ($active_grok_command)"
elif [ -n "$active_grok_command" ]; then
  warn "launchd active GROK_COMMAND 不是 isolated launcher: $active_grok_command"
  note "修復：launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/$LABEL.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$LABEL.plist"
else
  note "無法從 launchctl 讀取 active GROK_COMMAND；繼續做 isolated HOME doctor"
fi
GROK_ISOLATION_DOCTOR="${GROK_ISOLATION_DOCTOR:-$GW_DIR/grok-isolation-doctor.sh}"
if [ -n "$GW_DIR" ] && [ -x "$GROK_ISOLATION_DOCTOR" ]; then
  if "$GROK_ISOLATION_DOCTOR" >/tmp/puc_grok_isolation.json 2>/tmp/puc_grok_isolation.err; then
    pass "Grok isolated HOME clean（未繼承 Claude HOME/env；目標 repo 指令另由 authority doctor 檢查）"
    note "$(tr '\n' ' ' </tmp/puc_grok_isolation.json | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-220)"
  else
    warn "Grok runner isolation doctor 失敗"
    note "$(cat /tmp/puc_grok_isolation.err /tmp/puc_grok_isolation.json 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-260)"
  fi
else
  warn "找不到 Grok isolation doctor：$GROK_ISOLATION_DOCTOR"
  note "修復：確認 gateway runtime 使用新版 grok-isolation-doctor.sh，避免 Grok 讀到 Claude 舊權限規則"
fi
AUTHORITY_REPO="${TATWO_AGENT_AUTHORITY_REPO:-}"
AUTHORITY_DOCTOR="${TATWO_AGENT_AUTHORITY_DOCTOR:-}"
if [ -z "$AUTHORITY_DOCTOR" ] && [ -n "$AUTHORITY_REPO" ]; then
  AUTHORITY_DOCTOR="$AUTHORITY_REPO/scripts/tatwo-agent-authority-doctor.sh"
fi
if [ -n "$AUTHORITY_REPO" ] || [ -n "$AUTHORITY_DOCTOR" ]; then
  if [ -n "$AUTHORITY_DOCTOR" ] && [ -x "$AUTHORITY_DOCTOR" ]; then
    if "$AUTHORITY_DOCTOR" --repo "${AUTHORITY_REPO:-$PWD}" --json >/tmp/puc_agent_authority.json 2>/tmp/puc_agent_authority.err; then
      if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_agent_authority.json 'j.ok===true' >/dev/null 2>&1; then
        pass "agent authority lanes clean（Claude/Grok 不會把 reviewer 規則當撤權）"
      else
        warn "agent authority doctor 回傳非 PASS"
        note "$(tr '\n' ' ' </tmp/puc_agent_authority.json | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-260)"
      fi
    else
      warn "agent authority doctor 執行失敗"
      note "$(cat /tmp/puc_agent_authority.err /tmp/puc_agent_authority.json 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-260)"
    fi
  else
    warn "指定了 TATWO_AGENT_AUTHORITY_REPO/DOCTOR，但找不到可執行 doctor"
    note "repo 內需有 scripts/tatwo-agent-authority-doctor.sh，避免 project CLAUDE.md/AGENTS.md 又把 builder 變 reviewer"
  fi
else
  note "未指定 TATWO_AGENT_AUTHORITY_REPO；略過目標 repo 的 Claude/Grok lane contract 檢查"
fi

echo "[3] model catalog"
if curl_retry "$GATEWAY_URL/v1/models" >/tmp/puc_models.json 2>/dev/null; then
  miss=""; for s in "${EXPECT_SLUGS[@]}"; do [ -n "$NODE_BIN" ] && json_has_model /tmp/puc_models.json "$s" >/dev/null 2>&1 || miss="$miss $s"; done
  [ -z "$miss" ] && pass "expected slugs 齊全" || warn "catalog 缺:$miss"
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_models.json '(()=>{const m=new Map((j.models||[]).map(x=>[x.slug,(x.supported_reasoning_levels||[]).map(v=>v.effort)]));const same=(s,e)=>JSON.stringify(m.get(s)||[])===JSON.stringify(e);return same("gpt-5.6-sol",["low","medium","high","xhigh"])&&same("fable-5",["low","medium","high","xhigh","max"])&&same("opus-5",["low","medium","high","xhigh","max"])&&same("grok-build",["low","medium","high","xhigh"])&&same("minimax-m3",[]);})()' >/dev/null 2>&1; then
    pass "推理檔位依 provider 原生能力精確對齊"
  else
    warn "推理檔位 catalog 與 provider 原生能力不一致"
    note "GPT=low..xhigh；Claude=low..max；Grok model reasoning=low..xhigh；MiniMax=不宣告"
  fi
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_models.json '(()=>{const allowed=new Set(["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.5","gpt-5.4","gpt-5.4-mini"]); return !(j.models||[]).some(m => m.capabilities && m.capabilities.backend==="chatgpt_subscription" && !allowed.has(m.slug));})()' >/dev/null 2>&1; then
    pass "GPT catalog 已限制為 5.4 / 5.5 / 5.6 系列"
  else
    warn "GPT catalog 有白名單外模型（應只列 gpt-5.4 / gpt-5.4-mini / gpt-5.5 / gpt-5.6-*）"
  fi
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_models.json '!(j.models||[]).some(m=>m.slug==="chatgpt-pro-consult")' >/dev/null 2>&1; then
    pass "chatgpt-pro-consult 已從 catalog/dropdown 隱藏"
  else
    warn "chatgpt-pro-consult 仍出現在 catalog，會誤導為獨立 Pro 模型"
  fi
  if [ -n "$NODE_BIN" ] && json_expr /tmp/puc_health.json 'j.routes && j.routes["chatgpt-pro-consult"] && j.routes["chatgpt-pro-consult"].listed_in_catalog===false && j.routes["chatgpt-pro-consult"].deprecated===true && j.routes["chatgpt-pro-consult"].replaced_by==="gpt-5.5"' >/dev/null 2>&1; then
    pass "chatgpt-pro-consult hidden compat route 保留給舊 thread"
  else
    warn "chatgpt-pro-consult hidden compat route metadata 異常"
  fi
  not_low="$([ -n "$NODE_BIN" ] && json_expr /tmp/puc_models.json '((j.models||[]).filter(m=>{const levels=Array.isArray(m.supported_reasoning_levels)?m.supported_reasoning_levels:(Array.isArray(m.capabilities?.reasoning_effort?.supported)?m.capabilities.reasoning_effort.supported:[]);return levels.length>0&&(m.default_reasoning_level||"")!=="low";}).map(m=>m.slug).join(" "))' 2>/dev/null || echo "")"
  [ -z "$not_low" ] && pass "reasoning-capable catalog defaults = low（不支援 reasoning 的模型可為 none）" || warn "可調 reasoning 的 catalog 模型有非 low default_reasoning_level:$not_low"
else warn "/v1/models 連不上"; fi

echo "[4] codex debug models（config 端到端接通）"
if command -v codex >/dev/null 2>&1; then
  codex debug models -c model_provider='"model_gateway"' >/tmp/puc_codex_models.json 2>/dev/null \
    && [ -n "$NODE_BIN" ] && json_has_model /tmp/puc_codex_models.json gpt-5.5 >/dev/null 2>&1 \
    && pass "codex 看得到 gateway catalog" || { warn "codex 看不到 gateway catalog"; note "config parse error 或被更新重設；檢查 [model_providers.model_gateway]"; }
else note "codex CLI 不在 PATH，略過"; fi

echo "[5] GPT passthrough route（無授權 = 可見 degraded auth 完成訊息，不進 retry loop）"
b=$(curl_stream_retry "$GATEWAY_URL/v1/responses" -H 'content-type: application/json' \
  -d '{"model":"chatgpt-pro-consult","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"x"}]}],"stream":true}' 2>/dev/null)
if printf '%s' "$b" | grep -q 'requires Codex ChatGPT Authorization' \
  && printf '%s' "$b" | grep -q '"degraded":true' \
  && printf '%s' "$b" | grep -q '"error_kind":"auth"' \
  && printf '%s' "$b" | grep -q '"retry_allowed":false' \
  && printf '%s' "$b" | grep -q 'response.completed' \
  && ! printf '%s' "$b" | grep -q 'response.failed'; then
  pass "deprecated chatgpt-pro-consult compat route 回傳單一可見 auth notice，且禁止 retry"
elif printf '%s' "$b" | grep -q 'response.completed'; then pass "GPT route 回了完整回應"
else warn "GPT route 回應異常"; note "'not implemented'→gateway 退版；404→hidden compat route 未保留或 config provider 沒接上"; fi

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
