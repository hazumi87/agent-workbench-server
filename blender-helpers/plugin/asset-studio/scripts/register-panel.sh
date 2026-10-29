#!/usr/bin/env bash
# Register (or re-register, after the app's port changed) this room's "Asset Studio"
# panel on YOUR seat: POST <engineUrl>/api/rooms/<room>/panels
#   {title:"Asset Studio", url:"http://127.0.0.1:<port>/rooms/<room>/view", icon:"image",
#    scripts:true, from:{paneid:$HARBOR_WB_PANEID}}
# Removes this seat's earlier Asset Studio panels for the room first (a panel's url cannot
# be PATCHed). Needs the app up and HARBOR_WB_PANEID set. Re-run after EVERY start.
#   scripts/register-panel.sh <room-id-or-name>
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" register-panel "$@"
