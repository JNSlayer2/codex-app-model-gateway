#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

fail=0
scan() {
  label=$1
  pattern=$2
  if git grep -nEI -- "$pattern" -- . ':!scripts/security-scan.sh'; then
    printf 'security scan failed: %s\n' "$label" >&2
    fail=1
  fi
}

scan "private keys" 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY'
scan "credential-shaped values" "(Bearer|token|api[_-]?key|secret|password)[[:space:]\"'=:]+[A-Za-z0-9_./+-]{20,}"
scan "machine-specific absolute paths" '(/Users/[^<$[:space:]/]+/|/home/[^<$[:space:]/]+/|/Volumes/[^<$[:space:]/]+/)'
scan "private network addresses" '(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)'

exit "$fail"
