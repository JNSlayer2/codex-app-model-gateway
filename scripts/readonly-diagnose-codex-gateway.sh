#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_APP_HOME:-$HOME/.codex}"
config_path="${CODEX_CONFIG:-$codex_home/config.toml}"
cache_path="${CODEX_MODELS_CACHE:-$codex_home/models_cache.json}"
state_db="${CODEX_STATE_SQLITE:-$codex_home/state_5.sqlite}"

detect_port() {
  if [[ -n "${CODEX_MODEL_GATEWAY_PORT:-}" ]]; then
    printf '%s\n' "$CODEX_MODEL_GATEWAY_PORT"
    return
  fi
  if [[ -f "$config_path" ]]; then
    awk -F'[:/"]+' '
      $0 ~ /^\[model_providers\.model_gateway\]/ { in_gateway=1; next }
      $0 ~ /^\[/ && $0 !~ /^\[model_providers\.model_gateway\]/ { in_gateway=0 }
      in_gateway && $0 ~ /base_url/ {
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^[0-9]+$/) {
            print $i
            exit
          }
        }
      }
    ' "$config_path"
  fi
}

port="$(detect_port)"
port="${port:-4177}"

section() {
  printf '\n## %s\n' "$1"
}

redact() {
  sed \
    -e "s#${HOME}#"'$HOME'"#g" \
    -e "s#${CODEX_HOME:-$codex_home}#"'$CODEX_HOME'"#g" \
    -e 's#Bearer [A-Za-z0-9._-]\{10,\}#Bearer [REDACTED]#g' \
    -e 's#[A-Za-z0-9._%+-]\+@[A-Za-z0-9.-]\+\.[A-Za-z]\{2,\}#[REDACTED_EMAIL]#g'
}

model_filter='^(gpt-5\.5|opus-4-7|opus-4-8|sonnet-4-6|haiku-4-6|fable-5)$'

section "Host"
printf 'user: %s\n' "$(id -un 2>/dev/null || true)"
printf 'codex_home: %s\n' "$codex_home" | redact
printf 'gateway_port: %s\n' "$port"

section "CLI"
if command -v codex >/dev/null 2>&1; then
  printf 'codex: %s\n' "$(command -v codex)" | redact
  codex --version 2>/dev/null | sed 's/^/codex_version: /' || true
else
  echo 'codex: missing'
fi
if command -v claude >/dev/null 2>&1; then
  printf 'claude: %s\n' "$(command -v claude)" | redact
  claude --version 2>/dev/null | sed 's/^/claude_version: /' || true
else
  echo 'claude: missing'
fi

section "Config Summary"
if [[ -f "$config_path" ]]; then
  printf 'config: %s\n' "$config_path" | redact
  awk '
    /^model[[:space:]]*=/ || /^model_provider[[:space:]]*=/ || /^model_reasoning_effort[[:space:]]*=/ { print }
    /^\[model_providers\.model_gateway\]/ { in_gateway=1; print; next }
    /^\[/ && $0 !~ /^\[model_providers\.model_gateway\]/ { in_gateway=0 }
    in_gateway && /(name|base_url|wire_api|requires_openai_auth)[[:space:]]*=/ { print }
  ' "$config_path" | redact
else
  printf 'config: missing (%s)\n' "$config_path" | redact
fi

section "Gateway Health"
if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  curl --max-time 3 -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null \
    | jq '{ok,provider,wire_api,requires_openai_auth,chatgpt_subscription_passthrough,capabilities}' \
    || echo 'gateway_health: unavailable'
else
  echo 'gateway_health: skipped_missing_curl_or_jq'
fi

section "Gateway Models"
if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  curl --max-time 3 -fsS "http://127.0.0.1:$port/v1/models" 2>/dev/null \
    | jq -r --arg re "$model_filter" '.models[]? | select(.slug|test($re)) | [.slug,.display_name,.capabilities.backend,.capabilities.codex_tools] | @tsv' \
    || echo 'gateway_models: unavailable'
else
  echo 'gateway_models: skipped_missing_curl_or_jq'
fi

section "Codex Debug Models"
if command -v codex >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  codex debug models -c model_provider='"model_gateway"' 2>/dev/null \
    | jq -r '.models[]?.slug' \
    | rg "$model_filter" \
    || echo 'codex_debug_model_gateway: target_models_missing'
else
  echo 'codex_debug_model_gateway: skipped_missing_codex_or_jq'
fi

section "State Summary"
if [[ -f "$state_db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$state_db" "select model_provider,count(*) from threads where archived=0 group by model_provider order by count(*) desc;" 2>/dev/null || true
  openai_unarchived="$(sqlite3 "$state_db" "select count(*) from threads where archived=0 and model_provider='openai';" 2>/dev/null || echo 0)"
  if [[ "${openai_unarchived:-0}" != "0" ]]; then
    echo "risk: unarchived openai threads may be hidden after switching the app to model_gateway"
    echo "fix: bash scripts/migrate-sidebar-threads-to-gateway.sh"
  else
    echo "ok: no unarchived openai thread/provider split"
  fi
else
  printf 'state_db: missing_or_sqlite_unavailable (%s)\n' "$state_db" | redact
fi

section "Static Risk Checks"
if [[ -f "$config_path" ]]; then
  if rg -q '\[model_providers\.(opus|sonnet|haiku|claude|grok|minimax)' "$config_path"; then
    echo 'risk: per-model provider block exists'
  else
    echo 'ok: no obvious per-model provider block'
  fi
  if rg -q '^model_provider\s*=\s*"model_gateway"' "$config_path"; then
    echo 'ok: top-level model_provider is model_gateway'
  else
    echo 'risk: top-level model_provider is not model_gateway'
  fi
  if rg -q 'requires_openai_auth\s*=\s*true' "$config_path"; then
    echo 'ok: requires_openai_auth true'
  else
    echo 'risk: requires_openai_auth=true not found'
  fi
fi

section "Do Not Share"
cat <<'NEXT'
不要貼 auth.json、token、完整 logs、SQLite dump、models_cache 全文、rollout 全文、私有 thread id、截圖或 signed app bundle 內容。
若需要交接，只回傳本診斷摘要、失敗命令、錯誤類型與已通過/未通過的驗收項。
NEXT
