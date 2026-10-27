#!/usr/bin/env bash
# Check installed server and web-build dependencies. The preserved app lock is
# source evidence only: it is scanned for advisories but never installed here.
set -euo pipefail
CHECKER='license-checker-rseidelsohn@5.0.1'
root="$(cd "$(dirname "$0")/.." && pwd)"
inventory="$(node "$root/ci/dependency-scopes.mjs" --install)"
status=0
while IFS=$'\t' read -r dir scope; do
  echo "== licences in $dir ($scope)"
  (cd "$root/$dir" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
  (cd "$root/$dir" && npx --yes "$CHECKER" --production --excludePrivatePackages --json | node "$root/ci/licences.mjs") || status=1
done <<< "$inventory"
exit "$status"
