#!/usr/bin/env bash
# Readiness (docs/tool-residents.md §4.1): 1. the app answers its
# ping; 2. Vikunja is configured, reachable and accepts the token. Each step is up / down /
# unknown. Human-readable by default; --json for one JSON line.
# Exit 0 = ready, 1 = something is down, 2 = could not tell (nothing down).
# Also publishes status/widget.json from what it saw, holding the start/stop
# lock when it can, so its line never lands between a stop and that stop's own.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
try_lock || true
exec node "$TOOL_MJS" preflight "$@"
