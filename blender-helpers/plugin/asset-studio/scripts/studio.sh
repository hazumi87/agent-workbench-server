#!/usr/bin/env bash
# Call one of the app's verbs for a room. Writes take a JSON body on stdin — send room
# text (a prompt) in a QUOTED heredoc, never interpolated into a command line:
#   scripts/studio.sh get_state <room>
#   scripts/studio.sh set_prompt <room> <<'JSON'
#   {"prompt": "a lighthouse at dusk, oil painting"}
#   JSON
#   scripts/studio.sh job_status <room> <job-id>
# verbs: get_state list_models history job_status set_model set_prompt set_params
#        set_ref clear_ref generate cancel reload_recipe set_budget
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" call "$@"
