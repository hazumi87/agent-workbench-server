# Sourced by the lifecycle scripts. Paths are derived from this file's own
# location, so the tool folder can live anywhere; nothing host-specific here.
# pwd -P: the PHYSICAL path, which is what node reports for the app's main
# module — the "is this an instance" rule compares the two.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATUS_DIR="$ROOT/status"
PID_FILE="$STATUS_DIR/app.pid"
APP_JSON="$STATUS_DIR/app.json"
LOCK_FILE="$STATUS_DIR/.lock"
LOG_DIR="$ROOT/work/logs"
APP_MAIN="$ROOT/app/server.mjs"
TOOL_MJS="$ROOT/scripts/lib/tool.mjs"

# One start/stop at a time. fd 9 holds the lock for the life of the script;
# the app itself is launched with 9>&- so it never inherits (and pins) it.
take_lock() {
  mkdir -p "$STATUS_DIR" "$LOG_DIR"
  exec 9>"$LOCK_FILE"
  if ! flock -w 10 9; then
    echo "another start/stop is still running (lock $LOCK_FILE)" >&2
    exit 4
  fi
}

# The same lock, but never fatal: an account that cannot write status/ still
# gets an answer, it just cannot hold the lock (or publish the status line).
try_lock() {
  mkdir -p "$STATUS_DIR" 2>/dev/null || return 1
  { exec 9>"$LOCK_FILE"; } 2>/dev/null && flock -w 10 9
}

# Every live pid running this tool's app, one per line. The rule lives in ONE
# place (app/state.mjs instancesOf); fails when the process table can't be read.
instances() {
  node "$TOOL_MJS" instances
}

is_instance() {
  instances 2>/dev/null | grep -xF "$1" >/dev/null
}

read_pid() {
  cat "$PID_FILE" 2>/dev/null || true
}
