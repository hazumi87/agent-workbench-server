#!/usr/bin/env bash
# Download one Library image (an output, or a reference) to work/look/ and print its
# path — then Read that file to SEE it. The look-and-judge step of iterating.
#   scripts/look.sh <library-asset-id>
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
exec node "$TOOL_MJS" look "$@"
