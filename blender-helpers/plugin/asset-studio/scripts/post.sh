#!/usr/bin/env bash
# Post one line to your workroom, authored by this pane — the fallback when
# fabric-mcp's room_post is not available. The line is read from stdin (use a
# quoted heredoc); the JSON is built in node, never by the shell, and always
# carries from:{paneid}. Engine URL and token file come from config.local.json
# (engineUrl, engineTokenFile) or HARBOR_WB_ENGINE_URL / ASSET_STUDIO_ENGINE_TOKEN_FILE.
#   scripts/post.sh [room-id-or-name] <<'LINE'
#   <line>
#   LINE
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" post "$@"
