#!/usr/bin/env bash
# Stop the app (idempotent): SIGTERM every instance, wait, SIGKILL fallback,
# remove run files. "Instance" = a node process running THIS tool's
# app/server.mjs (app/state.mjs), so a recycled pid or an unrelated process is
# never signalled, and an instance started outside start.sh is stopped too.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
take_lock

GRACE="${ASSET_STUDIO_STOP_GRACE:-5}" # seconds to wait after SIGTERM

if ! pids="$(instances)"; then
  echo "cannot read the process table — could not tell whether the app is running; nothing signalled" >&2
  exit 2
fi
if [[ -z "$pids" ]]; then
  cleared="$(node "$TOOL_MJS" clear-stale)"
  node "$TOOL_MJS" status --publish >/dev/null
  echo "not running${cleared:+ ($cleared)}"
  exit 0
fi
stopped="$(echo $pids)"

any_alive() {
  local p
  for p in $pids; do kill -0 "$p" 2>/dev/null && return 0; done
  return 1
}

kill -TERM $pids 2>/dev/null || true
how="SIGTERM"
for ((i = 0; i < GRACE * 10; i++)); do
  any_alive || break
  sleep 0.1
done
pids="$(instances || true)"
if [[ -n "$pids" ]]; then
  kill -KILL $pids 2>/dev/null || true
  how="SIGKILL after ${GRACE}s"
  for ((i = 0; i < 20; i++)); do
    any_alive || break
    sleep 0.1
  done
fi
left="$(instances || true)"
if [[ -n "$left" ]]; then
  echo "could not stop pid $(echo $left) (another account's process?)" >&2
  exit 1
fi

# An instance that needed SIGKILL left its run files: recorded as a fault.
node "$TOOL_MJS" clear-stale >/dev/null
rm -f "$PID_FILE" "$APP_JSON"
node "$TOOL_MJS" status --publish >/dev/null
echo "stopped (pid $stopped, $how)"
