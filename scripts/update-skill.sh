#!/usr/bin/env bash
# update-skill.sh — one-command updater for a codex-app-model-gateway checkout.
#
# Usage (human or AI agent):
#   bash scripts/update-skill.sh           # pull + offline self-checks only (safe, read-only)
#   bash scripts/update-skill.sh --apply   # ALSO re-run the installer (rewrites plist/config
#                                          # with backups) and the post-update acceptance check
#
# Exit 0 = success; non-zero = stop and read the output.
# Without --apply this never touches auth, config.toml, launchd, or the running gateway.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
apply=0
[ "${1:-}" = "--apply" ] && apply=1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git checkout; re-clone instead:" >&2
  echo "  git clone https://github.com/JNSlayer2/codex-app-model-gateway" >&2
  exit 2
fi

before="$(git rev-parse --short HEAD)"
git fetch --quiet origin
git pull --ff-only
after="$(git rev-parse --short HEAD)"

# Offline self-checks (no quota, no machine state changes).
node --check runtime/server.js
(cd runtime && npm test >/dev/null 2>&1) && echo "runtime tests: green" || { echo "runtime tests FAILED — run: cd runtime && npm test" >&2; exit 1; }
bash -n scripts/install-codex-gateway.sh
bash -n scripts/post-update-check.sh

if [ "$apply" = 1 ]; then
  # Idempotent repair path: detects local CLI paths, rewrites plist + single-provider
  # config (with backups), reloads launchd, then runs the acceptance check.
  bash scripts/install-codex-gateway.sh
  bash scripts/post-update-check.sh
else
  echo "next (optional, changes machine state): bash scripts/update-skill.sh --apply"
fi

if [ "$before" = "$after" ]; then
  echo "codex-app-model-gateway already up to date ($after)"
else
  echo "codex-app-model-gateway updated $before -> $after"
fi
