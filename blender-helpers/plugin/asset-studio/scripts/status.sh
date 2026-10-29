#!/usr/bin/env bash
# The pulse. Prints one JSON line {state, pid, port, lastExit, checkedAt, reason}
# and nothing else — READ-ONLY (docs/session-taxonomy.md invariant 2: probes are
# read-only). Exit 0 whenever it produced an answer; the answer is the JSON.
#   state    up      = one instance, the one start.sh launched, and /health answers
#            down    = certainly not running (stopped, or a crash left run files)
#            unknown = could not tell: not answering, several / unlaunched instances, no /proc
#   lastExit clean | fault | null — how the last run ended (the taxonomy's `exit` verb)
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" status
