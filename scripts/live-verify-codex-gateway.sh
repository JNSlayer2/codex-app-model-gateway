#!/usr/bin/env bash
set -u

gateway_url="${GATEWAY_URL:-http://127.0.0.1:4177}"
gateway_dir="${MODEL_GATEWAY_DIR:-}"
run_claude="${RUN_CLAUDE_SMOKE:-1}"
run_grok="${RUN_GROK_SMOKE:-1}"
run_minimax="${RUN_MINIMAX_SMOKE:-0}"
run_app_server="${RUN_APP_SERVER_SMOKE:-1}"
run_same_thread="${RUN_SAME_THREAD_SMOKE:-1}"
models_re='^(gpt-5\.5|opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6|grok-build|minimax-m3)$'
claude_models=(opus-4-7 opus-4-8 sonnet-4-6 haiku-4-6)
grok_models=(grok-build)
minimax_models=(minimax-m3)
failures=0

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
if [[ -z "$gateway_dir" && -f "$repo_root/gateway/package.json" ]]; then
  gateway_dir="$repo_root/gateway"
fi

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }
note() { printf 'NOTE %s\n' "$*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

json_payload() {
  local model="$1"
  local text="$2"
  jq -nc --arg model "$model" --arg text "$text" \
    '{model:$model,input:[{type:"message",role:"user",content:[{type:"input_text",text:$text}]}],stream:true}'
}

need_cmd curl
need_cmd jq
need_cmd rg

if [[ -n "$gateway_dir" && -f "$gateway_dir/package.json" ]]; then
  if (cd "$gateway_dir" && npm test >/tmp/codex-gateway-npm-test.log 2>&1 && node --check server.js); then
    pass "gateway npm test and node --check"
  else
    fail "gateway npm test or node --check failed; see /tmp/codex-gateway-npm-test.log"
  fi
else
  fail "gateway dir not found; set MODEL_GATEWAY_DIR=<gateway-dir>"
fi

health="$(curl -fsS "$gateway_url/healthz" 2>/tmp/codex-gateway-health.err || true)"
if [[ -n "$health" ]] && jq -e '
  .ok == true and
  .provider == "model_gateway" and
  .chatgpt_subscription_passthrough == "proxy" and
  .capabilities.openai.codex_tools == "passthrough" and
  .capabilities.claude.codex_tools == "prompt_bridge_experimental" and
  .capabilities.grok.codex_tools == "prompt_bridge_experimental" and
  .capabilities.minimax.codex_tools == "prompt_bridge_experimental"
' >/dev/null <<<"$health"; then
  pass "healthz capability matrix"
else
  fail "healthz capability matrix mismatch"
fi

catalog="$(curl -fsS "$gateway_url/v1/models" 2>/tmp/codex-gateway-models.err || true)"
if [[ -n "$catalog" ]]; then
  missing=0
  for slug in gpt-5.5 "${claude_models[@]}" "${grok_models[@]}" "${minimax_models[@]}"; do
    if ! jq -e --arg slug "$slug" '.models[]? | select(.slug == $slug)' >/dev/null <<<"$catalog"; then
      fail "gateway catalog missing $slug"
      missing=1
    fi
  done
  if [[ "$missing" -eq 0 ]]; then
    if jq -r '.models[]? | select(.slug|test("^(opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6)$")) | .display_name' <<<"$catalog" | rg -q '^claude-'; then
      fail "gateway catalog has claude-prefixed display name"
    else
      pass "gateway catalog slugs, compact Claude display names, Grok model name, and MiniMax model name"
    fi
  fi
else
  fail "gateway catalog unavailable"
fi

if command -v codex >/dev/null 2>&1; then
  debug_models="$(codex debug models -c model_provider='"model_gateway"' 2>/tmp/codex-debug-models.err | jq -r '.models[]?.slug' || true)"
  if printf '%s\n' "$debug_models" | rg -q "$models_re"; then
    missing=0
    for slug in gpt-5.5 "${claude_models[@]}" "${grok_models[@]}" "${minimax_models[@]}"; do
      if ! printf '%s\n' "$debug_models" | rg -qx "$slug"; then
        fail "codex debug models missing $slug"
        missing=1
      fi
    done
    [[ "$missing" -eq 0 ]] && pass "codex debug models sees gateway catalog"
  else
    fail "codex debug models did not expose expected gateway models"
  fi
else
  fail "codex CLI unavailable"
fi

gpt_no_auth="$(curl -sS -N "$gateway_url/v1/responses" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.5","input":"no auth should fail","stream":true}' || true)"
if printf '%s\n' "$gpt_no_auth" | rg -q 'Authorization headers' && printf '%s\n' "$gpt_no_auth" | rg -q '"status":401'; then
  pass "GPT passthrough rejects requests without Codex session authorization"
else
  fail "GPT passthrough unauthenticated guard did not return clear 401"
fi

if [[ "$run_app_server" == "1" && -x "$(command -v codex 2>/dev/null)" ]]; then
  app_out="$(codex debug app-server send-message-v2 '只回 OK_GPT55_GATEWAY_VERIFY。' 2>&1 || true)"
  if printf '%s\n' "$app_out" | rg -q 'model_provider: "model_gateway"|modelProvider": "model_gateway"' &&
     printf '%s\n' "$app_out" | rg -q 'OK_GPT55_GATEWAY_VERIFY'; then
    pass "app-server GPT smoke through model_gateway"
  else
    fail "app-server GPT smoke did not prove model_gateway + visible GPT response"
  fi
else
  note "skipping app-server GPT smoke"
fi

same_thread_smoke="$script_dir/app-server-same-thread-smoke.js"
if [[ "$run_same_thread" == "1" && "$run_app_server" == "1" && "$run_claude" == "1" ]]; then
  if [[ -f "$same_thread_smoke" ]]; then
    if node "$same_thread_smoke" >/tmp/codex-gateway-same-thread-smoke.log 2>&1; then
      pass "app-server same-thread GPT -> all Claude -> GPT context smoke"
    else
      fail "app-server same-thread smoke failed; see /tmp/codex-gateway-same-thread-smoke.log"
      tail -n 20 /tmp/codex-gateway-same-thread-smoke.log >&2 || true
    fi
  else
    fail "same-thread smoke helper missing: $same_thread_smoke"
  fi
else
  note "skipping app-server same-thread GPT -> all Claude -> GPT smoke"
fi


if [[ "$run_grok" == "1" ]]; then
  for model in "${grok_models[@]}"; do
    tag="OK_${model//-/_}"
    payload="$(json_payload "$model" "只回 ${tag}。")"
    out="$(curl --max-time 90 -sS -N "$gateway_url/v1/responses" \
      -H 'content-type: application/json' \
      -d "$payload" || true)"
    if printf '%s\n' "$out" | rg -q 'response.failed|not authenticated|error'; then
      fail "Grok live smoke failed for $model: $(printf '%s\n' "$out" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-220)"
    elif printf '%s\n' "$out" | rg -q "$tag" &&
         printf '%s\n' "$out" | rg -q 'response.output_item.done' &&
         printf '%s\n' "$out" | rg -q 'response.completed'; then
      pass "Grok live smoke $model"
    else
      fail "Grok live smoke incomplete for $model"
    fi
  done
else
  note "skipping Grok live smoke"
fi

if [[ "$run_minimax" == "1" ]]; then
  for model in "${minimax_models[@]}"; do
    tag="OK_${model//-/_}"
    payload="$(json_payload "$model" "只回 ${tag}。")"
    out="$(curl --max-time 90 -sS -N "$gateway_url/v1/responses" \
      -H 'content-type: application/json' \
      -d "$payload" || true)"
    if printf '%s\n' "$out" | rg -q 'response.failed|not authenticated|disabled by policy|quota|billing|error'; then
      fail "MiniMax live smoke failed for $model: $(printf '%s\n' "$out" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-220)"
    elif printf '%s\n' "$out" | rg -q "$tag" &&
         printf '%s\n' "$out" | rg -q 'response.output_item.done' &&
         printf '%s\n' "$out" | rg -q 'response.completed'; then
      pass "MiniMax live smoke $model"
    else
      fail "MiniMax live smoke incomplete for $model"
    fi
  done
else
  note "skipping MiniMax live smoke (set RUN_MINIMAX_SMOKE=1)"
fi

if [[ "$run_claude" == "1" ]]; then
  for model in "${claude_models[@]}"; do
    tag="OK_${model//-/_}"
    payload="$(json_payload "$model" "只回 ${tag}。")"
    out="$(curl --max-time 90 -sS -N "$gateway_url/v1/responses" \
      -H 'content-type: application/json' \
      -d "$payload" || true)"
    if printf '%s\n' "$out" | rg -q 'response.failed|session limit|resets|error'; then
      fail "Claude live smoke failed for $model: $(printf '%s\n' "$out" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-220)"
    elif printf '%s\n' "$out" | rg -q "$tag" &&
         printf '%s\n' "$out" | rg -q 'response.output_item.done' &&
         printf '%s\n' "$out" | rg -q 'response.completed'; then
      pass "Claude live smoke $model"
    else
      fail "Claude live smoke incomplete for $model"
    fi
  done
else
  note "skipping Claude live smoke"
fi

if [[ "$failures" -eq 0 ]]; then
  printf 'PASS codex app model gateway live verification\n'
  exit 0
fi

printf 'FAIL codex app model gateway live verification: %s failure(s)\n' "$failures" >&2
exit 1
