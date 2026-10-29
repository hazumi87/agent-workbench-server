#!/usr/bin/env bash
# The open rooms where THIS pane holds a seat, as one JSON line
# [{id, name, seat, handle}] — the room id every task.sh call needs.
# Engine URL and token file from config.local.json; needs HARBOR_WB_PANEID.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" rooms
