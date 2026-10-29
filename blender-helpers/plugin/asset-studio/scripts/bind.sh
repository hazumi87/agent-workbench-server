#!/usr/bin/env bash
# Bind the app to ONE room (access: exclusive — the app refuses every other room).
# This pane must hold a seat in it; the room's name and this seat's handle are recorded
# (~/.local/state/asset-studio/binding.json, 0600) and go on every Library output as its origin.
#   scripts/bind.sh <room-id-or-name>
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" bind "$@"
