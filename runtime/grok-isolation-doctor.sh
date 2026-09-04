#!/usr/bin/env bash
# Verify that Grok can run from the gateway's isolated HOME without inheriting
# Claude HOME/env settings, skills, plugins, or hooks. Target-repo project
# instructions are checked separately by tatwo-agent-authority-doctor.sh,
# because coding agents should still read AGENTS.md/CLAUDE.md when scoped to a
# repository; those files must be lane-safe instead of hidden.
set -euo pipefail

REAL_HOME="${GROK_REAL_HOME:-$HOME}"
ISOLATED_HOME="${GROK_ISOLATED_HOME:-$REAL_HOME/.tatwo-agent-homes/grok-codex-gateway}"
GROK_BIN="${GROK_COMMAND:-$(command -v grok || true)}"

if [ -z "$GROK_BIN" ]; then
  echo "FAIL: grok binary not found" >&2
  exit 1
fi

mkdir -p "$ISOLATED_HOME/.grok" "$ISOLATED_HOME/.config" "$ISOLATED_HOME/.cache"
chmod 700 "$ISOLATED_HOME" "$ISOLATED_HOME/.grok" "$ISOLATED_HOME/.config" "$ISOLATED_HOME/.cache" 2>/dev/null || true

if [ -f "$REAL_HOME/.grok/auth.json" ] && [ ! -e "$ISOLATED_HOME/.grok/auth.json" ]; then
  ln -s "$REAL_HOME/.grok/auth.json" "$ISOLATED_HOME/.grok/auth.json" 2>/dev/null || cp "$REAL_HOME/.grok/auth.json" "$ISOLATED_HOME/.grok/auth.json"
  chmod 600 "$ISOLATED_HOME/.grok/auth.json" 2>/dev/null || true
fi

OUT="$(mktemp /tmp/grok-isolation-doctor.XXXXXX.json)"
ERR="$(mktemp /tmp/grok-isolation-doctor.XXXXXX.err)"
trap 'rm -f "$OUT" "$ERR"' EXIT

env -u CLAUDE_CONFIG_DIR \
  -u CLAUDE_HOME \
  -u CLAUDE_PLUGIN_ROOT \
  -u CLAUDE_PLUGIN_DATA \
  -u CLAUDE_PROJECT_DIR \
  -u ANTHROPIC_API_KEY \
  HOME="$ISOLATED_HOME" \
  GROK_HOME="$ISOLATED_HOME/.grok" \
  XDG_CONFIG_HOME="$ISOLATED_HOME/.config" \
  XDG_CACHE_HOME="$ISOLATED_HOME/.cache" \
  "$GROK_BIN" inspect --json >"$OUT" 2>"$ERR" || {
  echo "FAIL: grok inspect failed" >&2
  cat "$ERR" >&2
  exit 1
}

python3 - "$OUT" "$ISOLATED_HOME" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
isolated_home = sys.argv[2]
text = json.dumps(payload, ensure_ascii=False)
bad_needles = [
    "/.claude/",
    "/.agents/",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PROJECT_DIR",
    "settings.local.json (settings)",
]
bad = [needle for needle in bad_needles if needle in text]
if bad:
    print("FAIL: Grok still inherited foreign runner sources: " + ", ".join(bad))
    sys.exit(1)

summary = {
    "ok": True,
    "isolatedHome": isolated_home,
    "projectInstructions": len(payload.get("projectInstructions") or []),
    "permissionSources": (payload.get("permissions") or {}).get("sources") or [],
    "skills": len(payload.get("skills") or []),
    "plugins": len(payload.get("plugins") or []),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY
