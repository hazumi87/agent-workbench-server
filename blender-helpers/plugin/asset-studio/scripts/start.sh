#!/usr/bin/env bash
# Start the app (idempotent). Exit 0 = ready; non-zero = not ready (see stderr).
# When bound to a room it also re-registers that room's panel (the port changes on every start).
#   the instance start.sh launched is running and answering -> report it, exit 0, start nothing
#   it is running but not answering                         -> exit 3 (stop.sh, then start again)
#   an instance start.sh did not launch is running          -> exit 3, start nothing (stop.sh stops it)
#   run files left by a crash                               -> record the fault, clear them, start fresh
#   not ready within 5 s                                    -> stop what was launched, exit 1
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"
take_lock

# Bound to a room → (re)register its panel now: the port changed, and a stale panel shows an
# empty frame (briefing-table's suggestion,). Never fatal — the app is up either way;
# without a pane (HARBOR_WB_PANEID) it just says to run register-panel.sh.
reregister() {
  local room
  room="$(node --input-type=module -e 'const { readBinding } = await import(process.argv[1]); const b = readBinding(); if (b) console.log(b.room_id)' "$ROOT/app/config.mjs")"
  [[ -n "$room" ]] || return 0
  if [[ -z "${HARBOR_WB_PANEID:-}" ]]; then
    echo "bound to $room but HARBOR_WB_PANEID is unset — run scripts/register-panel.sh $room from your pane" >&2
    return 0
  fi
  if node "$TOOL_MJS" register-panel "$room" >/dev/null 2>&1; then
    echo "panel re-registered in room $room"
  else
    echo "could not re-register the panel — run scripts/register-panel.sh $room" >&2
  fi
}

if ! pids="$(instances)"; then
  echo "cannot read the process table — could not tell whether the app is running; not starting" >&2
  exit 2
fi
pid="$(read_pid)"
if [[ -n "$pids" ]]; then
  if [[ "$pids" == "$pid" ]]; then
    if out="$(node "$TOOL_MJS" wait-ready "$pid" 1500 2>/dev/null)"; then
      echo "already running (pid $pid) $out"
      reregister
      exit 0
    fi
    echo "running (pid $pid) but not answering /health — run scripts/stop.sh, then start again" >&2
    exit 3
  fi
  echo "this app is already running outside start.sh (pid $(echo $pids)) — run scripts/stop.sh (it stops every instance), then start again" >&2
  exit 3
fi
node "$TOOL_MJS" clear-stale >&2

setsid nohup node "$APP_MAIN" >>"$LOG_DIR/app.log" 2>&1 </dev/null 9>&- &  # setsid: survive the caller's process group
pid=$!
echo "$pid" >"$PID_FILE"

if out="$(node "$TOOL_MJS" wait-ready "$pid" 5000)"; then
  node "$TOOL_MJS" status --publish >/dev/null
  echo "started (pid $pid) $out"
  reregister
  exit 0
fi
echo "app did not become ready within 5 s — stopping it (log: $LOG_DIR/app.log)" >&2
if is_instance "$pid"; then
  kill -TERM "$pid" 2>/dev/null || true
  sleep 1
  if is_instance "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
fi
rm -f "$PID_FILE" "$APP_JSON"
node "$TOOL_MJS" status --publish >/dev/null || true
exit 1
